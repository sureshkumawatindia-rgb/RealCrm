const mongoose = require('mongoose');
const Call = require('../models/Call');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const User = require('../models/User');
const TelephonyConnection = require('../models/TelephonyConnection');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { normalizePhone } = require('../utils/phone');
const { isManager } = require('../constants/permissions');
const { END_STATUSES } = require('../constants/calls');
const { visibilityFilter } = require('./access');
const contactService = require('./contactService');
const leadService = require('./leadService');
const telephonyService = require('./telephonyService');
const telephony = require('../integrations/telephony');

// Calls with customers (Phase 6, D85).
//   log      — a call made from one's own phone, written down (outcome, duration, note)
//   dial     — click-to-call through the company's telephony connection: the member's phone rings
//              first, then the customer; the call is saved as queued and the webhook finishes it
//   webhook  — status updates from the provider, found by the connection's key and the call id
//              within that company only; idempotent; a finished call never goes back
// A call is activity: its lead's lastActivityAt and the contact's lastContactedAt move.
// No recording is stored.

function serialize(call) {
  return {
    id: call._id,
    contactId: call.contactId,
    leadId: call.leadId || null,
    memberId: call.memberId || null,
    direction: call.direction,
    status: call.status,
    outcome: call.outcome || null,
    durationSec: call.durationSec,
    startedAt: call.startedAt,
    endedAt: call.endedAt || null,
    notes: call.notes,
    provider: call.provider,
    toNumber: call.toNumber,
    fromNumber: call.fromNumber,
    error: call.error || '',
    createdAt: call.createdAt,
  };
}

// The contact (visible to this member) and, when given, its lead (visible too, and its own).
async function partiesOf(req, contactId, leadId) {
  const contact = await contactService.findVisible(req, contactId);
  let lead = null;
  if (leadId) {
    lead = await leadService.findVisible(req, leadId);
    if (String(lead.contactId) !== String(contact._id)) throw httpError(400, 'VALIDATION_ERROR', 'That lead belongs to another customer.', [{ field: 'leadId', code: 'LEAD_CONTACT_MISMATCH', message: 'Pick a lead of this customer.' }]);
  }
  return { contact, lead };
}

async function touch(call) {
  const at = call.endedAt || call.startedAt || new Date();
  await Contact.updateOne({ _id: call.contactId, organizationId: call.organizationId, $or: [{ lastContactedAt: null }, { lastContactedAt: { $lt: at } }] }, { $set: { lastContactedAt: at } });
  if (call.leadId) await Lead.updateOne({ _id: call.leadId, organizationId: call.organizationId, $or: [{ lastActivityAt: null }, { lastActivityAt: { $lt: at } }] }, { $set: { lastActivityAt: at } });
}

// GET /calls — members who see only their own records see the calls they made.
async function list(req, query) {
  const filter = {
    organizationId: req.tenant.organizationId,
    ...(query.contactId && { contactId: query.contactId }),
    ...(query.leadId && { leadId: query.leadId }),
    ...(query.memberId && { memberId: query.memberId }),
    ...((query.from || query.to) && { startedAt: { ...(query.from && { $gte: query.from }), ...(query.to && { $lte: query.to }) } }),
    ...visibilityFilter(req, ['customers'], 'memberId'),
  };
  if (query.contactId) await contactService.findVisible(req, query.contactId);
  const calls = await Call.find(filter).sort({ startedAt: -1 }).limit(query.limit || 50);
  return calls.map(serialize);
}

// POST /calls — written down by hand.
async function log(req, body) {
  const { contact, lead } = await partiesOf(req, body.contactId, body.leadId);
  const startedAt = body.at ? new Date(body.at) : new Date();
  const call = await Call.create({
    organizationId: req.tenant.organizationId,
    contactId: contact._id,
    leadId: lead?._id,
    memberId: req.member._id,
    direction: body.direction || 'out',
    status: ['no_answer', 'busy', 'switched_off'].includes(body.outcome) ? 'no_answer' : 'completed',
    outcome: body.outcome,
    durationSec: body.durationSec || 0,
    startedAt,
    endedAt: new Date(startedAt.getTime() + (body.durationSec || 0) * 1000),
    notes: body.notes || '',
    provider: 'manual',
    toNumber: body.direction === 'in' ? '' : contact.phoneE164 || contact.phone || '',
    fromNumber: body.direction === 'in' ? contact.phoneE164 || contact.phone || '' : '',
    createdById: req.user._id,
  });
  await touch(call);
  await audit(req, { action: 'call.logged', entityType: 'Call', entityId: call._id, changes: { outcome: call.outcome, durationSec: call.durationSec } });
  return serialize(call);
}

async function findOwn(req, id) {
  const call = mongoose.isValidObjectId(id) ? await Call.findOne({ _id: id, organizationId: req.tenant.organizationId }) : null;
  if (!call) throw httpError(404, 'NOT_FOUND', 'Call not found');
  return call;
}

// PATCH /calls/:id — the outcome and the note (who made it, or owners and admins).
async function update(req, id, body) {
  const call = await findOwn(req, id);
  if (!isManager(req.member) && String(call.memberId) !== String(req.member._id)) throw httpError(403, 'FORBIDDEN', 'Only the person who made this call, or an owner or admin, can change it.');
  if (body.outcome !== undefined) call.outcome = body.outcome;
  if (body.notes !== undefined) call.notes = body.notes;
  if (body.durationSec !== undefined && call.provider === 'manual') call.durationSec = body.durationSec;
  await call.save();
  await audit(req, { action: 'call.updated', entityType: 'Call', entityId: call._id, changes: Object.keys(body) });
  return serialize(call);
}

// The member's own number: their verified mobile, else the one on their member profile.
async function memberNumber(req) {
  const user = await User.findById(req.user._id).select('phoneE164').lean();
  return user?.phoneE164 || normalizePhone(req.member.mobile) || null;
}

// POST /calls/dial — click-to-call.
async function dial(req, body) {
  const organizationId = req.tenant.organizationId;
  const { contact, lead } = await partiesOf(req, body.contactId, body.leadId);
  const connection = await TelephonyConnection.findOne({ organizationId });
  const provider = connection && telephony.providerFor(connection.provider);
  if (!provider) throw httpError(409, 'NOT_CONNECTED', 'Calling is not set up. An owner or admin connects a calling provider in Settings → Calling.');
  const to = contact.phoneE164 || normalizePhone(contact.phone);
  if (!to) throw httpError(400, 'NO_PHONE', 'This customer has no phone number.');
  const from = await memberNumber(req);
  if (!from) throw httpError(400, 'MEMBER_NO_PHONE', 'Add your mobile number in Settings → My profile: the CRM rings it first, then the customer.');
  const call = await Call.create({
    organizationId, contactId: contact._id, leadId: lead?._id, memberId: req.member._id, direction: 'out', status: 'queued',
    provider: connection.provider, connectionId: connection._id, fromNumber: from, toNumber: to, startedAt: new Date(), createdById: req.user._id,
  });
  try {
    const placed = await provider.connect(telephonyService.credentialsOf(connection), { from, to, statusCallback: telephonyService.webhookUrlOf(connection) });
    call.providerCallId = placed.providerCallId;
    call.status = placed.status || 'queued';
    await call.save();
    await TelephonyConnection.updateOne({ _id: connection._id }, { $set: { lastCallAt: new Date(), status: 'active', lastError: '' } });
  } catch (error) {
    call.status = 'failed';
    call.error = String(error.message).slice(0, 300);
    call.endedAt = new Date();
    await call.save();
    await TelephonyConnection.updateOne({ _id: connection._id }, { $set: { lastError: call.error } });
    await audit(req, { action: 'call.failed', entityType: 'Call', entityId: call._id, changes: { error: call.error } });
    throw Object.assign(httpError(502, 'CALL_FAILED', `The call could not be placed: ${call.error}`), { details: serialize(call) });
  }
  await touch(call);
  await audit(req, { action: 'call.dialled', entityType: 'Call', entityId: call._id, changes: { provider: call.provider } });
  return serialize(call);
}

// POST /webhooks/calls/:key — the provider's status update. → HTTP status for the provider.
const RANK = { queued: 0, ringing: 1, in_progress: 2 };
async function receiveWebhook(key, rawBody, headers = {}) {
  const connection = await telephonyService.findByWebhookKey(key);
  if (!connection) return 404;
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  let fields = {};
  try {
    fields = String(headers['content-type'] || '').includes('json') || text.trim().startsWith('{') ? JSON.parse(text || '{}') : Object.fromEntries(new URLSearchParams(text));
  } catch {
    return 400;
  }
  const provider = telephony.providerFor(connection.provider);
  if (!provider) return 404;
  const update = provider.parseStatus(fields);
  if (!update.providerCallId || !update.status) return 200; // nothing we follow
  const call = await Call.findOne({ organizationId: connection.organizationId, provider: connection.provider, providerCallId: update.providerCallId });
  if (!call) {
    logger.warn(`A ${connection.provider} status for an unknown call ${update.providerCallId}`);
    return 200;
  }
  if (END_STATUSES.includes(call.status)) return 200; // finished calls never go back
  if (!END_STATUSES.includes(update.status) && (RANK[update.status] ?? 0) <= (RANK[call.status] ?? 0)) return 200;
  call.status = update.status;
  if (END_STATUSES.includes(update.status)) {
    call.endedAt = update.endedAt || new Date();
    if (update.durationSec !== null) call.durationSec = update.durationSec;
    if (!call.outcome && ['busy', 'no_answer'].includes(update.status)) call.outcome = update.status;
  }
  await call.save();
  await touch(call);
  return 200;
}

module.exports = { list, log, update, dial, receiveWebhook, serialize, touch }; // touch: WhatsApp calls too (G7)
