const Contact = require('../models/Contact');
const DialerSession = require('../models/DialerSession');
const TelephonyConnection = require('../models/TelephonyConnection');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const leadService = require('./leadService');
const boardService = require('./boardService');
const callService = require('./callService');

// The power dialer (Phase 8B, D89): a member's list of customers (picked leads, or a board of
// leads), called one after another. "Call" places one click-to-call through Calling (D85) — a
// person presses it every time; the outcome goes on that call, or a call is logged by hand when
// the company has no calling account. Saving an outcome claims the item first, so a double tap
// never logs two calls. A follow-up date can be set in the same step.
const MAX_ITEMS = 200;
const DAY = 24 * 60 * 60 * 1000;
const TALKED = ['connected', 'interested', 'callback', 'not_interested'];

function serialize(session, { calling = null } = {}) {
  const items = session.items.map((item, index) => ({
    index, leadId: item.leadId, contactId: item.contactId, label: item.label, title: item.title, status: item.status,
    callId: item.callId || null, outcome: item.outcome, reason: item.reason, at: item.at || null,
  }));
  const count = (status) => items.filter((i) => i.status === status).length;
  const next = items.find((i) => i.status === 'pending');
  return {
    id: session._id,
    name: session.name,
    status: session.status,
    items,
    next: next ? next.index : null,
    stats: { total: items.length, done: count('done'), skipped: count('skipped'), pending: count('pending'), talked: items.filter((i) => TALKED.includes(i.outcome)).length },
    ...(calling !== null && { calling }),
    createdAt: session.createdAt,
  };
}

const callingOf = async (organizationId) => Boolean(await TelephonyConnection.exists({ organizationId }));

async function own(req, id) {
  const session = await DialerSession.findOne({ _id: id, organizationId: req.tenant.organizationId, memberId: req.member._id });
  if (!session) throw httpError(404, 'NOT_FOUND', 'Dialer session not found');
  return session;
}

function itemOf(session, n) {
  const item = session.items[n];
  if (!item) throw httpError(404, 'NOT_FOUND', 'No such customer in this session.');
  return item;
}

// POST /dialer/sessions { leadIds | boardId, name? } — the visible leads whose customer has a
// number, in the given order; the others are listed as left out.
async function create(req, { leadIds = [], boardId, name = '' }) {
  let ids = leadIds;
  let title = name;
  if (boardId) {
    const board = await boardService.get(req, boardId);
    if (board.object !== 'lead') throw httpError(400, 'VALIDATION_ERROR', 'Pick a board of leads.');
    if (board.layout === 'calendar') throw httpError(400, 'VALIDATION_ERROR', 'Pick a table or Kanban board: a calendar shows only some dates.');
    ids = (await boardService.items(req, boardId, {})).items.map((lead) => String(lead.id));
    title = title || board.name;
  }
  ids = [...new Set(ids.map(String))].slice(0, MAX_ITEMS);
  const items = [];
  const leftOut = [];
  for (const id of ids) {
    let lead;
    try {
      lead = await leadService.findVisible(req, id);
    } catch {
      leftOut.push({ leadId: id, code: 'NOT_FOUND' });
      continue;
    }
    const contact = await Contact.findOne({ _id: lead.contactId, organizationId: req.tenant.organizationId }).select('name phone phoneE164');
    if (!contact?.phoneE164 && !contact?.phone) {
      leftOut.push({ leadId: id, code: 'NO_PHONE', label: contact?.name || lead.title });
      continue;
    }
    items.push({ leadId: lead._id, contactId: contact._id, label: contact.name || '', title: lead.title || '' });
  }
  if (!items.length) throw httpError(422, 'NOTHING_TO_CALL', 'None of these leads has a customer with a phone number you can see.');
  const session = await DialerSession.create({ organizationId: req.tenant.organizationId, memberId: req.member._id, name: title.slice(0, 80) || `Calls ${new Date().toLocaleDateString('en-IN')}`, items });
  await audit(req, { action: 'dialer.started', entityType: 'DialerSession', entityId: session._id, changes: { items: items.length, leftOut: leftOut.length } });
  return { ...serialize(session, { calling: await callingOf(req.tenant.organizationId) }), leftOut };
}

async function list(req) {
  const sessions = await DialerSession.find({ organizationId: req.tenant.organizationId, memberId: req.member._id }).sort({ createdAt: -1 }).limit(10);
  return sessions.map((s) => serialize(s));
}

const get = async (req, id) => serialize(await own(req, id), { calling: await callingOf(req.tenant.organizationId) });

// POST /dialer/sessions/:id/items/:n/call — one click-to-call, pressed by the member.
async function call(req, id, n) {
  const session = await own(req, id);
  const item = itemOf(session, n);
  if (session.status !== 'active' || item.status !== 'pending') throw httpError(409, 'ITEM_DONE', 'This customer is already done in this session.');
  try {
    const placed = await callService.dial(req, { contactId: String(item.contactId), leadId: String(item.leadId) });
    await DialerSession.updateOne({ _id: session._id }, { $set: { [`items.${n}.callId`]: placed.id } });
    return { call: placed, session: serialize(await own(req, id)) };
  } catch (error) {
    if (error.details?.id) await DialerSession.updateOne({ _id: session._id }, { $set: { [`items.${n}.callId`]: error.details.id } });
    throw error;
  }
}

// POST /dialer/sessions/:id/items/:n/result { outcome, notes?, minutes?, followUpInDays? }
async function result(req, id, n, { outcome, notes = '', minutes, followUpInDays }) {
  const session = await own(req, id);
  const item = itemOf(session, n);
  if (item.status !== 'pending') return { session: serialize(session), alreadyDone: true };
  // Claim it first: a second tap finds it done and logs nothing.
  const claimed = await DialerSession.findOneAndUpdate(
    { _id: session._id, [`items.${n}.status`]: 'pending' },
    { $set: { [`items.${n}.status`]: 'done', [`items.${n}.outcome`]: outcome, [`items.${n}.at`]: new Date() } },
    { returnDocument: 'after' },
  );
  if (!claimed) return { session: serialize(await own(req, id)), alreadyDone: true };
  let saved;
  try {
    saved = item.callId
      ? await callService.update(req, String(item.callId), { outcome, notes })
      : await callService.log(req, { contactId: String(item.contactId), leadId: String(item.leadId), outcome, notes, direction: 'out', durationSec: Math.round((minutes || 0) * 60) });
  } catch (error) {
    await DialerSession.updateOne({ _id: session._id }, { $set: { [`items.${n}.status`]: 'pending', [`items.${n}.outcome`]: '' } });
    throw error;
  }
  if (!item.callId) await DialerSession.updateOne({ _id: session._id }, { $set: { [`items.${n}.callId`]: saved.id } });
  let followUp = null;
  if (followUpInDays !== undefined && followUpInDays !== null) {
    const at = new Date(Date.now() + followUpInDays * DAY);
    at.setUTCHours(4, 30, 0, 0); // 10:00 in India
    try {
      followUp = (await leadService.update(req, String(item.leadId), { followUpAt: at })).followUpAt;
    } catch (error) {
      followUp = { error: error.message };
    }
  }
  return { session: serialize(await own(req, id)), call: saved, followUp };
}

async function skip(req, id, n, { reason = '' } = {}) {
  const session = await own(req, id);
  itemOf(session, n);
  await DialerSession.updateOne({ _id: session._id, [`items.${n}.status`]: 'pending' }, { $set: { [`items.${n}.status`]: 'skipped', [`items.${n}.reason`]: String(reason).slice(0, 200), [`items.${n}.at`]: new Date() } });
  return serialize(await own(req, id));
}

async function finish(req, id) {
  const session = await own(req, id);
  if (session.status === 'active') {
    session.status = 'finished';
    session.finishedAt = new Date();
    await session.save();
    await audit(req, { action: 'dialer.finished', entityType: 'DialerSession', entityId: session._id, changes: serialize(session).stats });
  }
  return serialize(session);
}

module.exports = { create, list, get, call, result, skip, finish, MAX_ITEMS };
