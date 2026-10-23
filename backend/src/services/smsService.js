const crypto = require('crypto');
const Contact = require('../models/Contact');
const ConsentEvent = require('../models/ConsentEvent');
const Lead = require('../models/Lead');
const SmsConnection = require('../models/SmsConnection');
const SmsMessage = require('../models/SmsMessage');
const env = require('../config/env');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { encrypt, decrypt } = require('../utils/secretBox');
const { isManager } = require('../constants/permissions');
const { MAX_SMS_TEMPLATES, SMS_RANK, STOP_WORDS, SMS_BLANK } = require('../constants/sms');
const sms = require('../integrations/sms');
const contactService = require('./contactService');

// SMS to customers (Phase 8A, D88) through the company's own MSG91 account and its DLT-approved
// templates. A send happens once per idempotency key (a retried job or a double click finds the
// message); an opted-out customer gets none; delivery reports and replies come to the
// connection's secret address and are matched within that company only.
const invalid = (field, message, code = 'INVALID') => httpError(400, 'VALIDATION_ERROR', message, [{ field, code, message }]);
const webhookUrlOf = (connection) => `${env.publicUrl}/api/v1/webhooks/sms/${connection.webhookKey}`;
const blanksOf = (text) => [...new Set([...String(text).matchAll(SMS_BLANK)].map((m) => m[1]))];
const render = (text, values) => String(text).replace(SMS_BLANK, (match, name) => (values[name] ?? ''));
const providers = () => ['msg91', ...(sms.mockAllowed() ? ['mock'] : [])];
const templateOut = (t) => ({ key: t.key, name: t.name, flowId: t.flowId, dltTemplateId: t.dltTemplateId, text: t.text, variables: t.variables });

function serializeConnection(connection, { full = true } = {}) {
  if (!connection) return { connected: false, providers: providers(), templates: [] };
  const templates = connection.templates.map(templateOut);
  if (!full) return { connected: true, templates: templates.map(({ key, name, text, variables }) => ({ key, name, text, variables })) };
  return {
    connected: true,
    provider: connection.provider,
    senderId: connection.senderId,
    hasKey: Boolean(connection.authKeyEnc),
    templates,
    status: connection.status,
    lastError: connection.lastError,
    lastSentAt: connection.lastSentAt || null,
    webhookUrl: webhookUrlOf(connection),
    providers: providers(),
  };
}

const connectionOf = (organizationId) => SmsConnection.findOne({ organizationId });
// GET /sms/connection: owners and admins see it all; others the templates they may send.
const getConnection = async (req) => serializeConnection(await connectionOf(req.tenant.organizationId), { full: isManager(req.member) });

// PUT /sms/connection (owners and admins). Templates keep their keys when their name stays.
async function saveConnection(req, body) {
  if (!sms.providerFor(body.provider)) throw invalid('provider', 'This SMS provider is not available.');
  const organizationId = req.tenant.organizationId;
  const existing = await connectionOf(organizationId);
  if (body.provider === 'msg91' && !body.authKey && !existing?.authKeyEnc) throw invalid('authKey', 'Give the MSG91 auth key.', 'REQUIRED');
  if ((body.templates || []).length > MAX_SMS_TEMPLATES) throw invalid('templates', `Up to ${MAX_SMS_TEMPLATES} templates.`, 'TOO_MANY');
  const names = new Set();
  const templates = (body.templates || []).map((t, index) => {
    if (names.has(t.name.toLowerCase())) throw invalid(`templates.${index}.name`, `Two templates are called "${t.name}".`, 'DUPLICATE');
    names.add(t.name.toLowerCase());
    if (body.provider === 'msg91' && !t.flowId) throw invalid(`templates.${index}.flowId`, `Give MSG91's template id for "${t.name}".`, 'REQUIRED');
    const kept = existing?.templates.find((x) => x.key === t.key || x.name.toLowerCase() === t.name.toLowerCase());
    return { key: kept?.key || crypto.randomBytes(6).toString('hex'), name: t.name, flowId: t.flowId || '', dltTemplateId: t.dltTemplateId || '', text: t.text, variables: blanksOf(t.text) };
  });
  const connection = await SmsConnection.findOneAndUpdate(
    { organizationId },
    {
      $set: { provider: body.provider, senderId: (body.senderId || '').toUpperCase(), templates, status: 'active', lastError: '', ...(body.authKey && { authKeyEnc: encrypt(body.authKey) }) },
      $setOnInsert: { webhookKey: crypto.randomBytes(16).toString('hex'), createdById: req.user._id },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  await audit(req, { action: existing ? 'sms.updated' : 'sms.connected', entityType: 'SmsConnection', entityId: connection._id, changes: { provider: body.provider, senderId: connection.senderId, templates: templates.length, newKey: Boolean(body.authKey) } });
  return serializeConnection(connection);
}

const credentialsOf = (connection) => ({ authKey: connection.authKeyEnc ? decrypt(connection.authKeyEnc) : '', senderId: connection.senderId });

async function testConnection(req) {
  const connection = await connectionOf(req.tenant.organizationId);
  if (!connection) throw httpError(404, 'NOT_CONNECTED', 'No SMS account is connected.');
  try {
    await sms.providerFor(connection.provider).test(credentialsOf(connection));
    await SmsConnection.updateOne({ _id: connection._id }, { $set: { status: 'active', lastError: '' } });
    return { ok: true };
  } catch (error) {
    await SmsConnection.updateOne({ _id: connection._id }, { $set: { status: 'error', lastError: error.message } });
    return { ok: false, error: error.message };
  }
}

async function removeConnection(req) {
  const removed = await SmsConnection.findOneAndDelete({ organizationId: req.tenant.organizationId });
  if (removed) await audit(req, { action: 'sms.disconnected', entityType: 'SmsConnection', entityId: removed._id, changes: { provider: removed.provider } });
  return { disconnected: Boolean(removed) };
}

function serialize(m) {
  return {
    id: m._id, contactId: m.contactId || null, leadId: m.leadId || null, direction: m.direction, source: m.source, templateName: m.templateName, text: m.text,
    to: m.to, from: m.from, status: m.status, error: m.error, sentAt: m.sentAt || null, deliveredAt: m.deliveredAt || null, createdAt: m.createdAt,
  };
}

// The send itself, once per key. values: the template's blanks, filled. Throws on a refusal
// (4xx) or a provider outage (5xx, retryable: a later try with the same key sends again).
async function dispatch({ organizationId, connection, contact, lead, template, values, source, memberId, idempotencyKey, enrollmentId, runId }) {
  if (!connection) throw httpError(409, 'SMS_NOT_CONNECTED', 'No SMS account is connected (Settings → SMS).');
  if (contact.smsOptOut?.at) throw httpError(422, 'SMS_OPTED_OUT', `${contact.name || 'The customer'} asked not to get SMS.`);
  const to = contact.phoneE164;
  if (!to) throw httpError(400, 'NO_PHONE', `${contact.name || 'The customer'} has no mobile number.`);
  const missing = template.variables.filter((name) => !String(values[name] ?? '').trim());
  if (missing.length) throw httpError(400, 'SMS_BLANK_EMPTY', `Nothing fills ##${missing.join('##, ##')}## for ${contact.name || 'this customer'}.`);
  const provider = sms.providerFor(connection.provider);
  if (!provider) throw httpError(409, 'SMS_NOT_CONNECTED', 'This SMS provider is not available.');

  let message;
  const fields = {
    organizationId, contactId: contact._id, leadId: lead?._id, memberId, direction: 'out', source, templateKey: template.key, templateName: template.name,
    text: render(template.text, values).slice(0, 2000), to, status: 'queued', provider: connection.provider, idempotencyKey, enrollmentId, runId,
  };
  try {
    message = await SmsMessage.create(fields);
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await SmsMessage.findOne({ organizationId, idempotencyKey });
    // A send that failed for a reason worth retrying is tried again under the same key.
    if (!existing || existing.status !== 'failed' || !existing.retryable) return existing;
    message = await SmsMessage.findOneAndUpdate({ _id: existing._id, status: 'failed', retryable: true }, { $set: { status: 'queued', error: '', retryable: false } }, { returnDocument: 'after' });
    if (!message) return SmsMessage.findById(existing._id);
  }
  try {
    const result = await provider.send(credentialsOf(connection), { to, template, values });
    message.status = 'sent';
    message.providerMessageId = result.providerMessageId || undefined;
    message.sentAt = new Date();
    await message.save();
    await SmsConnection.updateOne({ _id: connection._id }, { $set: { lastSentAt: new Date(), status: 'active', lastError: '' } });
    if (lead) await Lead.updateOne({ _id: lead._id }, { $set: { lastActivityAt: new Date() } });
    return message;
  } catch (error) {
    const retryable = Boolean(error.retryable);
    await SmsMessage.updateOne({ _id: message._id }, { $set: { status: 'failed', error: String(error.message).slice(0, 500), retryable } });
    if (error.code === 'SMS_AUTH') await SmsConnection.updateOne({ _id: connection._id }, { $set: { status: 'error', lastError: error.message } });
    throw error;
  }
}

const templateOf = (connection, key) => connection?.templates.find((t) => t.key === key);

// POST /sms (Customers edit): one SMS by hand. values: the blanks as typed.
async function send(req, { contactId, leadId, template: key, values = {} }, idempotencyKey) {
  const contact = await contactService.findVisible(req, contactId);
  const organizationId = req.tenant.organizationId;
  const connection = await connectionOf(organizationId);
  const template = templateOf(connection, key);
  if (connection && !template) throw invalid('template', 'Pick one of your SMS templates.', 'INVALID_TEMPLATE');
  const lead = leadId ? await Lead.findOne({ _id: leadId, organizationId, contactId: contact._id }) : null;
  if (leadId && !lead) throw invalid('leadId', 'That deal is not this customer\'s.', 'INVALID_LEAD');
  const message = await dispatch({ organizationId, connection, contact, lead, template: template || { variables: [] }, values, source: 'manual', memberId: req.member._id, idempotencyKey });
  return serialize(message);
}

// From a workflow or sequence step (and bulk): blanks filled from the CRM with fill(spec, ctx).
async function sendFromStep({ organizationId, contact, lead, templateKey, valuesFor, source, idempotencyKey, enrollmentId, runId, memberId }) {
  const connection = await connectionOf(organizationId);
  const template = templateOf(connection, templateKey);
  if (connection && !template) throw httpError(422, 'TEMPLATE_GONE', 'The SMS template was removed from Settings → SMS.');
  return dispatch({ organizationId, connection, contact, lead, template: template || { variables: [] }, values: template ? valuesFor(template.variables) : {}, source, memberId, idempotencyKey, enrollmentId, runId });
}

async function list(req, { contactId }) {
  const contact = await contactService.findVisible(req, contactId);
  const items = await SmsMessage.find({ organizationId: req.tenant.organizationId, contactId: contact._id }).sort({ createdAt: -1 }).limit(100);
  return items.map(serialize);
}

// SMS opt-out (D88): kept on the customer, with its history (ConsentEvent, channel sms).
async function setOptOut({ organizationId, contact, optedOut, method, memberId, actorName = '', detail = '' }) {
  const was = Boolean(contact.smsOptOut?.at);
  if (was === optedOut) return contact;
  const updated = await Contact.findOneAndUpdate(
    { _id: contact._id, organizationId },
    optedOut ? { $set: { smsOptOut: { at: new Date(), method } } } : { $unset: { smsOptOut: 1 } },
    { returnDocument: 'after' },
  );
  await ConsentEvent.create({ organizationId, contactId: contact._id, channel: 'sms', from: was ? 'opted_out' : 'unknown', to: optedOut ? 'opted_out' : 'unknown', method, memberId, actorName, detail: String(detail).slice(0, 500) });
  return updated;
}

// POST /contacts/:id/sms-consent (Customers edit).
async function setConsent(req, contactId, { optedOut }) {
  const contact = await contactService.findVisible(req, contactId);
  const updated = await setOptOut({ organizationId: req.tenant.organizationId, contact, optedOut, method: req.apiKey ? 'api' : 'manual', memberId: req.member?._id, actorName: req.user?.name || '' });
  await audit(req, { action: optedOut ? 'contact.sms_opted_out' : 'contact.sms_opted_in', entityType: 'Contact', entityId: contact._id });
  return { contactId: contact._id, smsOptOut: updated.smsOptOut?.at ? { at: updated.smsOptOut.at, method: updated.smsOptOut.method } : null };
}

const findByWebhookKey = (key) => (/^[a-f0-9]{32}$/.test(String(key || '')) ? SmsConnection.findOne({ webhookKey: key }) : null);
const isStop = (text) => STOP_WORDS.includes(String(text || '').trim().toLowerCase().replace(/[.!]+$/, ''));

// POST /webhooks/sms/:key → HTTP status. Delivery reports move a message forward once; an
// incoming SMS is kept (it stops sequences that stop on a reply), and STOP opts the sender out.
async function receiveWebhook(key, rawBody, headers = {}) {
  const connection = await findByWebhookKey(key);
  if (!connection) return 404;
  const provider = sms.providerFor(connection.provider);
  if (!provider) return 404;
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  let fields;
  try {
    fields = String(headers['content-type'] || '').includes('json') || /^\s*[[{]/.test(text) ? JSON.parse(text || '{}') : Object.fromEntries(new URLSearchParams(text));
  } catch {
    return 400;
  }
  const organizationId = connection.organizationId;
  const { reports, inbound } = provider.parseWebhook(fields);
  for (const report of reports) {
    const message = await SmsMessage.findOne({ organizationId, provider: connection.provider, providerMessageId: report.providerMessageId });
    if (!message) continue;
    if ((SMS_RANK[report.status] ?? 0) <= (SMS_RANK[message.status] ?? 0)) continue; // a duplicate or late report
    await SmsMessage.updateOne(
      { _id: message._id, status: message.status },
      { $set: { status: report.status, ...(report.status === 'delivered' && { deliveredAt: new Date() }), ...(report.status === 'failed' && { error: report.error.slice(0, 500) }) } },
    );
  }
  for (const incoming of inbound) {
    const digits = incoming.from.replace(/\D/g, '');
    const phoneE164 = `+${digits.length === 10 ? `91${digits}` : digits}`;
    const contact = await Contact.findOne({ organizationId, phoneE164 });
    await SmsMessage.create({ organizationId, contactId: contact?._id, direction: 'in', source: 'customer', text: incoming.text.slice(0, 2000), from: phoneE164, status: 'received', provider: connection.provider });
    if (contact && isStop(incoming.text)) {
      await setOptOut({ organizationId, contact, optedOut: true, method: 'sms_reply', actorName: 'Customer', detail: incoming.text });
      logger.info(`SMS opt-out by reply for contact ${contact._id}`);
    }
  }
  return 200;
}

// The customer wrote an SMS after `since` (sequences that stop on a reply).
const repliedSince = (organizationId, contactId, since) => SmsMessage.exists({ organizationId, contactId, direction: 'in', createdAt: { $gt: since } });

module.exports = {
  getConnection, saveConnection, testConnection, removeConnection, send, sendFromStep, list, setConsent, setOptOut, receiveWebhook, repliedSince,
  serialize, serializeConnection, render, blanksOf, webhookUrlOf, connectionOf, templateOf,
};
