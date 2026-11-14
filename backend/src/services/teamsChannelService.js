const mongoose = require('mongoose');
const TeamsChannel = require('../models/TeamsChannel');
const Lead = require('../models/Lead');
const Contact = require('../models/Contact');
const Quotation = require('../models/Quotation');
const Order = require('../models/Order');
const Ticket = require('../models/Ticket');
const env = require('../config/env');
const logger = require('../config/logger');
const bus = require('../realtime/bus');
const httpError = require('../utils/httpError');
const { encrypt, decrypt } = require('../utils/secretBox');
const { audit } = require('../utils/audit');
const { assertPublicHttps } = require('../utils/safeWebhook');
const { TEAMS_EVENTS, TEAMS_EVENT_LABELS, TEAMS_HOSTS } = require('../constants/microsoft');

// Notes in a Microsoft Teams channel (Phase 4B, D83), with no Microsoft sign-in: the company makes
// a Teams "Workflows" webhook ("Post to a channel when a webhook request is received") and pastes
// its address here, then picks the business events. Each event posts one card through the job
// queue: 5xx and no answer are retried; three refusals (4xx) in a row switch the channel off with
// the reason. The address holds a secret signature, so it is stored encrypted and shown as a hint.
const JOB = 'teams.post';
const TIMEOUT_MS = 10000;
const MAX_REFUSALS = 3;
const MAX_CHANNELS = 10;

const rupees = (paise) => `₹${(Math.round(Number(paise) || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const crmLink = (page) => `${env.frontendUrl.replace(/\/+$/, '')}/${page}`;

function serialize(channel) {
  return {
    id: channel._id, name: channel.name, urlHint: channel.urlHint, events: channel.events, active: channel.active,
    disabledReason: channel.disabledReason, lastStatus: channel.lastStatus, lastError: channel.lastError, lastSentAt: channel.lastSentAt || null,
    createdAt: channel.createdAt,
  };
}

// Only a Teams address: https, on a Teams / Power Automate host, not a private network.
async function checkedUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw httpError(400, 'TEAMS_URL', 'Paste the address Teams gave for the workflow (it starts with https://).');
  }
  if (url.protocol !== 'https:' || !TEAMS_HOSTS.some((host) => host.test(url.hostname))) {
    throw httpError(400, 'TEAMS_URL', 'This is not a Teams workflow address. In Teams, use Workflows → "Post to a channel when a webhook request is received", then copy its address (…logic.azure.com, …powerplatform.com or …webhook.office.com).');
  }
  await assertPublicHttps(url.toString());
  return url;
}
const hintOf = (url) => `${url.hostname} …${url.toString().slice(-6)}`;

async function findOwn(req, id) {
  const channel = mongoose.isValidObjectId(id) ? await TeamsChannel.findOne({ _id: id, organizationId: req.tenant.organizationId }) : null;
  if (!channel) throw httpError(404, 'NOT_FOUND', 'Teams channel not found');
  return channel;
}

async function list(req) {
  const channels = await TeamsChannel.find({ organizationId: req.tenant.organizationId }).sort({ createdAt: 1 });
  return { items: channels.map(serialize), events: TEAMS_EVENTS.map((key) => ({ key, label: TEAMS_EVENT_LABELS[key] })) };
}

async function create(req, { name, url, events }) {
  if (await TeamsChannel.countDocuments({ organizationId: req.tenant.organizationId }) >= MAX_CHANNELS) throw httpError(409, 'LIMIT', `A company can post to at most ${MAX_CHANNELS} Teams channels.`);
  const checked = await checkedUrl(url);
  const channel = await TeamsChannel.create({ organizationId: req.tenant.organizationId, name, urlEnc: encrypt(checked.toString()), urlHint: hintOf(checked), events, createdById: req.user._id });
  await audit(req, { action: 'teams_channel.created', entityType: 'TeamsChannel', entityId: channel._id, changes: { name, events, host: checked.hostname } });
  return serialize(channel);
}

async function update(req, id, patch) {
  const channel = await findOwn(req, id);
  if (patch.url) {
    const checked = await checkedUrl(patch.url);
    channel.urlEnc = encrypt(checked.toString());
    channel.urlHint = hintOf(checked);
  }
  if (patch.name !== undefined) channel.name = patch.name;
  if (patch.events !== undefined) channel.events = patch.events;
  if (patch.active !== undefined) {
    channel.active = patch.active;
    if (patch.active) Object.assign(channel, { disabledReason: '', refusals: 0 });
  }
  await channel.save();
  await audit(req, { action: 'teams_channel.updated', entityType: 'TeamsChannel', entityId: channel._id, changes: Object.keys(patch).map((key) => (key === 'url' ? 'address' : key)) });
  return serialize(channel);
}

async function remove(req, id) {
  const channel = await findOwn(req, id);
  await TeamsChannel.deleteOne({ _id: channel._id });
  await audit(req, { action: 'teams_channel.deleted', entityType: 'TeamsChannel', entityId: channel._id, changes: { name: channel.name } });
}

// --- the card ---------------------------------------------------------------------------------
// Teams Workflows (and the older incoming webhooks) take an Adaptive Card in a "message".
function cardMessage({ title, facts = [], link, linkTitle = 'Open in agreem360' }) {
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
          ...(facts.length ? [{ type: 'FactSet', facts: facts.filter(([, value]) => value !== '' && value !== undefined && value !== null).map(([factTitle, value]) => ({ title: factTitle, value: String(value) })) }] : []),
        ],
        ...(link && { actions: [{ type: 'Action.OpenUrl', title: linkTitle, url: link }] }),
      },
    }],
  };
}

const nameOf = async (contactId) => (contactId ? (await Contact.findById(contactId).select('name').lean())?.name || '' : '');

// The card for a business event, from the records (no phone numbers: a channel may be wide).
async function cardFor(type, event) {
  if (type === 'lead.created' || type === 'lead.won') {
    const lead = await Lead.findById(event.leadId).select('title expectedValuePaise source contactId').lean();
    const customer = await nameOf(lead?.contactId || event.contactId);
    return cardMessage({
      title: type === 'lead.won' ? `🏆 Won: ${lead?.title || 'a lead'}` : `New lead: ${lead?.title || 'Enquiry'}`,
      facts: [['Customer', customer], ['Value', lead?.expectedValuePaise ? rupees(lead.expectedValuePaise) : ''], ['Source', lead?.source || event.source || '']],
      link: crmLink(`leads.html#${event.leadId}`),
    });
  }
  if (type === 'quotation.accepted') {
    const quotation = await Quotation.findById(event.quotationId).select('number totals contactId').lean();
    return cardMessage({ title: `✅ Quotation ${quotation?.number || ''} accepted`, facts: [['Customer', await nameOf(quotation?.contactId || event.contactId)], ['Total', rupees(quotation?.totals?.grandTotalPaise)]], link: crmLink('Quotations.html') });
  }
  if (type === 'payment.received') {
    const order = event.orderId ? await Order.findById(event.orderId).select('number contactId').lean() : null;
    return cardMessage({ title: `💰 Payment received${order?.number ? ` for ${order.number}` : ''}`, facts: [['Customer', await nameOf(order?.contactId || event.contactId)], ['Amount', rupees(event.amountPaise)]], link: crmLink('Orders.html') });
  }
  if (type === 'ticket.created') {
    const ticket = await Ticket.findById(event.ticketId).select('number subject priority contactId').lean();
    return cardMessage({ title: `🎫 Ticket #${ticket?.number || ''}: ${ticket?.subject || ''}`, facts: [['Customer', await nameOf(ticket?.contactId || event.contactId)], ['Priority', ticket?.priority || '']], link: crmLink('Support.html') });
  }
  return cardMessage({ title: type });
}

// Which Teams event an automation event is (a stage change only when it is Won).
function teamsTypeOf(event) {
  if (event.type === 'lead.stage_changed') return event.to === 'Won' ? 'lead.won' : null;
  if (event.type === 'quotation.status_changed') return event.to === 'Accepted' ? 'quotation.accepted' : null;
  return TEAMS_EVENTS.includes(event.type) ? event.type : null;
}

// --- sending ----------------------------------------------------------------------------------
// → { status }. Throws { retry: true } for no answer or 5xx; a 4xx comes back as { status }.
async function send(channel, message) {
  const url = await assertPublicHttps(decrypt(channel.urlEnc));
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'agreem360-Teams/1' }, body: JSON.stringify(message), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw Object.assign(new Error(`Teams at ${url.host} did not answer.`), { retry: true });
  }
  if (response.status >= 500 || response.status === 429) throw Object.assign(new Error(`Teams answered ${response.status}.`), { retry: true });
  return { status: response.status };
}

// Records the outcome; three refusals in a row switch the channel off.
async function record(channel, { status, error }) {
  if (status >= 200 && status < 300) {
    await TeamsChannel.updateOne({ _id: channel._id }, { $set: { lastStatus: 'sent', lastError: '', lastSentAt: new Date(), refusals: 0 } });
    return true;
  }
  const refusals = status ? (channel.refusals || 0) + 1 : channel.refusals || 0;
  const off = refusals >= MAX_REFUSALS;
  const message = error || `Teams refused the card (${status}).`;
  await TeamsChannel.updateOne({ _id: channel._id }, { $set: { lastStatus: 'failed', lastError: message, refusals, ...(off && { active: false, disabledReason: `Switched off: Teams refused ${MAX_REFUSALS} cards in a row (${status}). Check the workflow in Teams, then switch it on again.` }) } });
  return false;
}

async function post({ channelId, type, event }) {
  const channel = await TeamsChannel.findById(channelId);
  if (!channel || !channel.active) return 'skipped';
  try {
    const { status } = await send(channel, await cardFor(type, event));
    return (await record(channel, { status })) ? 'sent' : 'refused';
  } catch (error) {
    await record(channel, { error: error.message });
    if (error.retry) throw error;
    return 'failed';
  }
}

// POST /integrations/teams-channels/:id/test — a test card now, on the company's own click.
async function test(req, id) {
  const channel = await findOwn(req, id);
  try {
    const { status } = await send(channel, cardMessage({ title: 'agreem360 is connected to this channel', facts: [['Events', channel.events.map((key) => TEAMS_EVENT_LABELS[key]).join(', ') || 'none chosen yet']], link: crmLink('Settings.html?tab=integrations') }));
    const ok = await record(channel, { status });
    return { sent: ok, status };
  } catch (error) {
    await record(channel, { error: error.message });
    return { sent: false, error: error.message };
  }
}

let listener = null;
function register(queue) {
  queue.define(JOB, (data) => post(data), { maxAttempts: 4 });
  if (listener) bus.off('automation:event', listener);
  listener = (event) => {
    const type = teamsTypeOf(event);
    if (!type) return;
    TeamsChannel.find({ organizationId: event.organizationId, active: true, events: type }).select('_id').lean()
      .then((channels) => Promise.all(channels.map((channel) => queue.enqueue(JOB, { channelId: String(channel._id), type, event }, { uniqueKey: `${JOB}:${channel._id}:${event.key}`, organizationId: event.organizationId }))))
      .catch((error) => logger.error(`Teams note for ${event.type} could not be queued: ${error.message}`));
  };
  bus.on('automation:event', listener);
}

module.exports = { JOB, register, list, create, update, remove, test, post, cardFor, teamsTypeOf, checkedUrl };
