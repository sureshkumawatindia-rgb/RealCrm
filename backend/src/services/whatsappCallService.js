const mongoose = require('mongoose');
const Call = require('../models/Call');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const Message = require('../models/Message');
const OrganizationMember = require('../models/OrganizationMember');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const logger = require('../config/logger');
const bus = require('../realtime/bus');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { isManager } = require('../constants/permissions');
const { OPEN_STAGES } = require('../constants/crm');
const { LIVE_STATUSES } = require('../constants/calls');
const { providerFor } = require('../integrations/whatsapp');
const accounts = require('./whatsappAccountService');
const conversationService = require('./conversationService');
const callService = require('./callService');
const notificationService = require('./notificationService');
const { previewOf } = require('./whatsappInboundService');

// WhatsApp calls (G7, D111): Meta's Calling API, checked first for Indian numbers (read
// 2026-11-02: customers' calls and business calls are both offered in India).
//   settings — owners and admins switch calls on for a number (Settings → WhatsApp); customers
//              then see WhatsApp's call button in their chat with the business.
//   incoming — Meta's "calls" webhook (connect, with the customer's audio offer): the call rings
//              in the Inbox of everyone who sees that chat. Whoever answers first takes it: their
//              browser makes the audio answer (WebRTC), the CRM hands it to Meta (pre_accept,
//              accept). Decline = reject.
//   outgoing — a teammate calls a customer who allowed it (they answered our request in the chat,
//              or — with "customers who call can be called back" — they called us in the last 7
//              days). The browser makes the offer; WhatsApp's answer comes in the connect webhook
//              and goes back to that browser only.
//   the end  — either side hangs up (terminate); Meta's webhook says how it ended and how long.
// Each call is a Call (provider whatsapp: the customer's history and the call log, D85) and a line
// in the chat. The sound goes between the browser and WhatsApp: the CRM never hears or keeps it.
const JOB = 'whatsapp.calls.sweep';
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const RING_LIMIT_MS = 3 * 60 * 1000; // still ringing (or not picked up) after this: nobody answered
const TALK_LIMIT_MS = 6 * 60 * 60 * 1000; // answered with no end after this: the end was lost
const DAY_MS = 24 * 60 * 60 * 1000;
const CALLBACK_MS = 7 * DAY_MS; // Meta: a customer's call, or a temporary "yes", allows 7 days of calls
const NO_PERMISSION_CODES = [138006]; // Meta: no permission to call this customer

const str = (value, max = 300) => (value == null ? '' : String(value).slice(0, max));
const unixTime = (value) => {
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) || !Number(value) ? new Date() : date;
};
const secondsBetween = (from, to) => (from ? Math.max(Math.round((to.getTime() - from.getTime()) / 1000), 0) : 0);

function serializeCall(call) {
  return {
    ...callService.serialize(call),
    accountId: call.whatsapp?.accountId || null,
    conversationId: call.whatsapp?.conversationId || null,
    answeredAt: call.whatsapp?.answeredAt || null,
  };
}

// --- settings (PUT /whatsapp/accounts/:id/calling, owners and admins) ----------------------------
async function setCalling(req, accountId, { enabled, callbackPermission = false }) {
  const account = await accounts.findInOrg(req, accountId);
  const settings = { enabled, callbackPermission: Boolean(enabled && callbackPermission) };
  try {
    await providerFor(account).setCalling(accounts.credentials(account), settings);
  } catch (error) {
    if (error.statusCode >= 500) throw error;
    throw httpError(400, 'CALLING_REFUSED', `WhatsApp did not change calls on this number: ${error.message}`);
  }
  account.calling = { ...settings, updatedAt: new Date() };
  await account.save();
  await audit(req, { action: enabled ? 'whatsapp.calling.enabled' : 'whatsapp.calling.disabled', entityType: 'WhatsAppAccount', entityId: account._id, changes: settings });
  return accounts.serializeAccount(account);
}

// --- the call's line in the chat -----------------------------------------------------------------
function durationText(sec) {
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  return minutes ? `${minutes} min${seconds ? ` ${seconds} s` : ''}` : `${seconds} s`;
}
// What the line (and the chat list) says, in English; the Inbox shows its own words from the status.
function lineText(call) {
  if (call.status === 'completed') return `WhatsApp call, ${durationText(call.durationSec || 0)}`;
  if (call.status === 'no_answer') return call.direction === 'in' ? 'Missed WhatsApp call' : 'WhatsApp call, not answered';
  if (call.status === 'busy') return 'WhatsApp call, declined';
  if (call.status === 'cancelled') return 'WhatsApp call, cancelled';
  if (call.status === 'failed') return 'WhatsApp call, failed';
  return 'WhatsApp call';
}
const lineFields = (call) => ({ type: 'call', text: lineText(call), call: { callId: call._id, status: call.status, durationSec: call.durationSec || 0 } });

// A teammate who answers or makes a call takes an unassigned chat, as with a reply (D25).
async function takeChat(conversation, memberId) {
  if (conversation.assigneeId || !memberId) return { conversation, previousAssigneeId: undefined };
  const updated = await Conversation.findOneAndUpdate({ _id: conversation._id, assigneeId: null }, { $set: { assigneeId: memberId } }, { returnDocument: 'after' });
  if (!updated) return { conversation: await Conversation.findById(conversation._id), previousAssigneeId: undefined };
  await conversationService.claimCustomer(updated, memberId);
  conversationService.announce('conversation:updated', updated, { previousAssigneeId: null });
  return { conversation: updated, previousAssigneeId: null };
}

// The line is added when the call starts. The chat comes back (open, out of the archive) and moves
// up; a customer's call counts as unread. A call never opens WhatsApp's 24-hour window: only a
// message from the customer does.
async function addLine(call, conversation, at) {
  const fields = lineFields(call);
  const incoming = call.direction === 'in';
  const message = await Message.create({
    organizationId: call.organizationId, conversationId: conversation._id, contactId: call.contactId, whatsappAccountId: conversation.whatsappAccountId,
    direction: call.direction, status: incoming ? 'received' : 'sent', providerTimestamp: at, ...(!incoming && { sentAt: at }),
    ...(!incoming && call.memberId && { sentByMemberId: call.memberId }), ...(conversation.private && { private: true }), ...fields,
  });
  if (incoming && conversation.status === 'closed') await Conversation.updateOne({ _id: conversation._id, status: 'closed' }, { $set: { openedAt: at } });
  let updated = await Conversation.findOneAndUpdate(
    { _id: conversation._id },
    { $set: { status: 'open' }, $unset: { archivedAt: 1, archivedById: 1 }, $max: { lastMessageAt: at }, ...(incoming && { $inc: { unreadCount: 1 } }) },
    { returnDocument: 'after' },
  );
  if (updated.lastMessageAt.getTime() === at.getTime()) {
    updated = await Conversation.findOneAndUpdate(
      { _id: conversation._id },
      { $set: { lastMessagePreview: previewOf(fields), lastMessageDirection: call.direction, lastMessageOrigin: '' } },
      { returnDocument: 'after' },
    );
  }
  call.whatsapp.messageId = message._id;
  await call.save();
  bus.emit('message:new', { organizationId: call.organizationId, conversation: updated, message });
  return updated;
}

// The line follows the call; everyone who sees the chat hears how it went (their ringing card
// closes). previousAssigneeId: the chat was just taken (the queue hears it too).
async function callChanged(call, { previousAssigneeId } = {}) {
  let conversation = await Conversation.findById(call.whatsapp?.conversationId);
  if (!conversation) return;
  if (call.whatsapp?.messageId) {
    const fields = lineFields(call);
    const message = await Message.findOneAndUpdate(
      { _id: call.whatsapp.messageId, organizationId: call.organizationId },
      { $set: { text: fields.text, 'call.status': call.status, 'call.durationSec': call.durationSec || 0 } },
      { returnDocument: 'after' },
    );
    if (message) {
      bus.emit('message:status', { organizationId: call.organizationId, message });
      // The chat list says how it ended while the call is the latest thing in the chat.
      const lineAt = message.providerTimestamp || message.createdAt;
      if (conversation.lastMessageAt && lineAt && conversation.lastMessageAt.getTime() === lineAt.getTime() && conversation.lastMessagePreview !== previewOf(fields)) {
        conversation = await Conversation.findOneAndUpdate({ _id: conversation._id }, { $set: { lastMessagePreview: previewOf(fields) } }, { returnDocument: 'after' });
        conversationService.announce('conversation:updated', conversation);
      }
    }
  }
  bus.emit('call:updated', { organizationId: call.organizationId, conversation, previousAssigneeId, call: serializeCall(call) });
}

// Whom to tell about a missed call: the chat's teammate; else the customer's owner; else the
// owners and admins (a private number's chat: the owners only, D61).
async function peopleFor(conversation, contact) {
  const { organizationId } = conversation;
  if (!conversation.private && conversation.assigneeId) return [conversation.assigneeId];
  if (!conversation.private && contact?.ownerId) return [contact.ownerId];
  const roles = conversation.private ? ['owner'] : ['owner', 'admin'];
  return (await OrganizationMember.find({ organizationId, role: { $in: roles }, status: 'active' }).select('_id')).map((m) => m._id);
}

// A call that just ended: its line, the customer's last contact, and a bell note for a missed call.
async function ended(call, options) {
  await callChanged(call, options);
  await callService.touch(call);
  if (call.direction !== 'in' || call.status !== 'no_answer') return;
  try {
    const conversation = await Conversation.findById(call.whatsapp?.conversationId);
    const contact = await Contact.findOne({ _id: call.contactId, organizationId: call.organizationId }).select('name phoneE164 ownerId');
    if (!conversation) return;
    await notificationService.notify(call.organizationId, await peopleFor(conversation, contact), {
      title: `Missed WhatsApp call from ${contact?.name || contact?.phoneE164 || 'a customer'}`,
      body: 'Call them back from the chat, or write to them.',
      link: `Inbox.html?c=${conversation._id}`,
      source: 'whatsapp-call',
    });
  } catch (error) {
    logger.error(`The missed-call note for call ${call._id} failed: ${error.message}`);
  }
}

// Ends a live call once (the first of the webhook, a hang-up or the sweep wins). → the call, or null.
async function close(call, set, options) {
  const done = await Call.findOneAndUpdate(
    { _id: call._id, status: { $in: LIVE_STATUSES } },
    { $set: { endedAt: new Date(), ...set }, $unset: { 'whatsapp.offer': 1, 'whatsapp.answer': 1 } },
    { returnDocument: 'after' },
  );
  if (done) await ended(done, options);
  return done;
}

const openLeadOf = (contact) => Lead.findOne({ organizationId: contact.organizationId, contactId: contact._id, stage: { $in: OPEN_STAGES } }).sort({ createdAt: -1 }).select('_id');

// --- the customer calls (from whatsappInboundService: the contact and chat are found or made) ------
async function incoming({ account, contact, conversation, lead, event }) {
  const at = unixTime(event.timestamp);
  // D103: a blocked customer's call is declined at once and not kept.
  if (contact.blocked?.at) {
    await providerFor(account).callAction(accounts.credentials(account), { callId: str(event.id), action: 'reject' })
      .catch((error) => logger.warn(`Declining a blocked customer's WhatsApp call failed: ${error.message}`));
    return 'ignored';
  }
  let call;
  try {
    call = await Call.create({
      organizationId: account.organizationId, contactId: contact._id, leadId: (lead || await openLeadOf(contact))?._id, direction: 'in', status: 'ringing',
      provider: 'whatsapp', providerCallId: str(event.id), startedAt: at, fromNumber: contact.phoneE164 || '', toNumber: account.displayPhone || '',
      whatsapp: { accountId: account._id, conversationId: conversation._id, offer: str(event.session?.sdp, 20000) },
    });
  } catch (error) {
    if (error.code === 11000) return 'ignored'; // the same call again
    throw error;
  }
  // A customer who calls may be called back for 7 days, when the number allows it (Meta's rule).
  let chat = conversation;
  const permission = conversation.callPermission || {};
  if (account.calling?.callbackPermission && !(permission.status === 'granted' && permission.permanent)) {
    chat = await Conversation.findOneAndUpdate(
      { _id: conversation._id },
      { $set: { callPermission: { status: 'granted', permanent: false, expiresAt: new Date(at.getTime() + CALLBACK_MS), requestedAt: permission.requestedAt, answeredAt: at, source: 'call' } } },
      { returnDocument: 'after' },
    );
  }
  chat = await addLine(call, chat, at);
  bus.emit('call:incoming', { organizationId: account.organizationId, conversation: chat, call: { ...serializeCall(call), sdp: call.whatsapp.offer || '' } });
  return 'processed';
}

// A call of ours by Meta's call id; the call's id we sent (biz_opaque_callback_data) finds one whose
// webhook came before Meta's answer to "connect" was saved.
async function findByEvent(account, id, tag) {
  const organizationId = account.organizationId;
  const call = await Call.findOne({ organizationId, provider: 'whatsapp', providerCallId: str(id) });
  if (call || !mongoose.isValidObjectId(tag)) return call;
  const tagged = await Call.findOne({ _id: tag, organizationId, provider: 'whatsapp', providerCallId: { $exists: false } });
  if (tagged) {
    tagged.providerCallId = str(id);
    await tagged.save();
  }
  return tagged;
}

// Meta's "calls" webhook for a call the CRM knows: WhatsApp's answer to our call (connect), or the
// end (terminate: COMPLETED or FAILED, with its length when it was answered). attempts: an end can
// arrive before the start was saved, so an unknown call is retried a few times.
async function callEvent(account, event, attempts = 1) {
  const call = await findByEvent(account, event.id, event.biz_opaque_callback_data);
  if (!call) {
    if (String(event.event) === 'terminate' && attempts < 3) throw new Error('The call of this event is not saved yet');
    return 'ignored';
  }
  if (event.event === 'connect') {
    const sdp = str(event.session?.sdp, 20000);
    if (call.direction !== 'out' || !LIVE_STATUSES.includes(call.status) || !sdp) return 'ignored';
    call.whatsapp.answer = sdp;
    await call.save();
    // Only the browser that made the call can use the answer.
    bus.emit('call:answer', { organizationId: call.organizationId, memberId: call.memberId, call: { id: call._id, sdp } });
    return 'processed';
  }
  if (event.event !== 'terminate') return 'ignored';
  // Meta's length (seconds; only for an answered call), else ours from the moment it was answered.
  const duration = event.duration == null || event.duration === '' ? NaN : Math.round(Number(event.duration));
  const endedAt = event.end_time ? unixTime(event.end_time) : unixTime(event.timestamp);
  if (!LIVE_STATUSES.includes(call.status)) {
    // Already ended here (a hang-up): Meta's length is the true one.
    if (call.status === 'completed' && Number.isFinite(duration) && duration >= 0 && duration !== call.durationSec) {
      call.durationSec = duration;
      await call.save();
      await callChanged(call);
    }
    return 'processed';
  }
  const answered = Boolean(call.whatsapp?.answeredAt) || call.status === 'in_progress' || duration > 0;
  let status = 'no_answer';
  if (answered) status = 'completed';
  else if (String(event.status).toUpperCase() === 'FAILED') status = 'failed';
  const set = { status, endedAt, durationSec: answered ? (Number.isFinite(duration) && duration >= 0 ? duration : secondsBetween(call.whatsapp?.answeredAt, endedAt)) : 0 };
  if (status === 'failed') set.error = str(event.errors?.[0]?.message || event.errors?.[0]?.title || 'WhatsApp could not connect the call.', 300);
  await close(call, set);
  return 'processed';
}

// Our call's progress (statuses of type "call"): RINGING, ACCEPTED (picked up), REJECTED.
async function callStatus(account, status) {
  const call = await findByEvent(account, status.id, status.biz_opaque_callback_data);
  if (!call || call.direction !== 'out' || !LIVE_STATUSES.includes(call.status)) return 'ignored';
  const value = String(status.status).toUpperCase();
  if (value === 'RINGING' && call.status === 'queued') {
    const moved = await Call.findOneAndUpdate({ _id: call._id, status: 'queued' }, { $set: { status: 'ringing' } }, { returnDocument: 'after' });
    if (moved) await callChanged(moved);
    return 'processed';
  }
  if (value === 'ACCEPTED' && call.status !== 'in_progress') {
    const moved = await Call.findOneAndUpdate(
      { _id: call._id, status: { $in: ['queued', 'ringing'] } },
      { $set: { status: 'in_progress', 'whatsapp.answeredAt': unixTime(status.timestamp) } },
      { returnDocument: 'after' },
    );
    if (moved) await callChanged(moved);
    return 'processed';
  }
  if (value === 'REJECTED') {
    await close(call, { status: 'busy' });
    return 'processed';
  }
  return 'ignored';
}

// G7: the customer answered our request to call them (from whatsappInboundService). → the chat.
async function permissionReplied(conversation, reply, at) {
  const before = conversation.callPermission || {};
  const set = reply.response === 'accept'
    ? { status: 'granted', permanent: Boolean(reply.permanent), ...(!reply.permanent && { expiresAt: reply.expiresAt || new Date(at.getTime() + CALLBACK_MS) }) }
    : { status: 'rejected' };
  return Conversation.findOneAndUpdate(
    { _id: conversation._id },
    { $set: { callPermission: { ...set, requestedAt: before.requestedAt, answeredAt: at, source: 'reply' } } },
    { returnDocument: 'after' },
  );
}

// --- from the Inbox ----------------------------------------------------------------------------
// A WhatsApp call of the company in a chat this member sees.
async function findCall(req, id) {
  const call = mongoose.isValidObjectId(id) ? await Call.findOne({ _id: id, organizationId: req.tenant.organizationId, provider: 'whatsapp' }) : null;
  if (!call) throw httpError(404, 'NOT_FOUND', 'Call not found');
  const conversation = await conversationService.findVisible(req, call.whatsapp?.conversationId);
  const account = await WhatsAppAccount.findOne({ _id: call.whatsapp?.accountId, organizationId: call.organizationId });
  if (!account) throw httpError(409, 'NUMBER_REMOVED', 'This chat\'s WhatsApp number was removed from Settings.');
  return { call, conversation, account };
}

// GET /whatsapp-calls/ringing — customers' calls ringing now in chats this member sees (an Inbox
// opened while a call rings shows it too).
async function ringing(req) {
  const calls = await Call.find({
    organizationId: req.tenant.organizationId, provider: 'whatsapp', direction: 'in', status: 'ringing', startedAt: { $gt: new Date(Date.now() - RING_LIMIT_MS) },
  }).sort({ startedAt: -1 }).limit(10);
  const items = [];
  for (const call of calls) {
    const conversation = await conversationService.get(req, call.whatsapp?.conversationId).catch(() => null);
    if (conversation) items.push({ conversation, call: { ...serializeCall(call), sdp: call.whatsapp?.offer || '' } });
  }
  return items;
}

// GET /whatsapp-calls/:id — the call; to the teammate who made it, WhatsApp's audio answer once it
// came (the browser asks when the live update did not reach it).
async function get(req, id) {
  const { call } = await findCall(req, id);
  const own = call.direction === 'out' && String(call.memberId) === String(req.member._id);
  return { ...serializeCall(call), ...(own && { sdp: call.whatsapp?.answer || '' }) };
}

// POST /whatsapp-calls/:id/answer { sdp } — the first teammate to answer takes the call.
async function answer(req, id, { sdp }) {
  const { call, conversation, account } = await findCall(req, id);
  if (call.direction !== 'in' || call.status !== 'ringing') throw httpError(409, 'CALL_NOT_RINGING', 'This call is no longer ringing.');
  const taken = await Call.findOneAndUpdate(
    { _id: call._id, status: 'ringing' },
    { $set: { status: 'in_progress', memberId: req.member._id, 'whatsapp.answeredAt': new Date() } },
    { returnDocument: 'after' },
  );
  if (!taken) throw httpError(409, 'CALL_TAKEN', 'Someone else answered this call, or it ended.');
  const provider = providerFor(account);
  try {
    // pre_accept lets WhatsApp set up the sound; accept connects the customer (the same answer).
    await provider.callAction(accounts.credentials(account), { callId: taken.providerCallId, action: 'pre_accept', sdp });
    await provider.callAction(accounts.credentials(account), { callId: taken.providerCallId, action: 'accept', sdp });
  } catch (error) {
    await close(taken, { status: 'failed', error: str(error.message, 300) });
    throw httpError(502, 'CALL_FAILED', `WhatsApp did not connect the call: ${error.message}`);
  }
  await Call.updateOne({ _id: taken._id }, { $unset: { 'whatsapp.offer': 1 } });
  const { previousAssigneeId } = await takeChat(conversation, req.member._id);
  await callChanged(taken, { previousAssigneeId });
  await audit(req, { action: 'call.answered', entityType: 'Call', entityId: taken._id, changes: { provider: 'whatsapp' } });
  return serializeCall(taken);
}

// POST /whatsapp-calls/:id/decline — the customer hears that the business is busy.
async function decline(req, id) {
  const { call, account } = await findCall(req, id);
  if (call.direction !== 'in' || call.status !== 'ringing') throw httpError(409, 'CALL_NOT_RINGING', 'This call is no longer ringing.');
  const declined = await close(call, { status: 'busy', memberId: req.member._id });
  if (!declined) throw httpError(409, 'CALL_TAKEN', 'Someone else answered this call, or it ended.');
  await providerFor(account).callAction(accounts.credentials(account), { callId: call.providerCallId, action: 'reject' })
    .catch((error) => logger.warn(`Declining WhatsApp call ${call.providerCallId} failed: ${error.message}`));
  await audit(req, { action: 'call.declined', entityType: 'Call', entityId: call._id, changes: { provider: 'whatsapp' } });
  return serializeCall(declined);
}

// POST /whatsapp-calls/:id/end — hang up (the teammate on the call, or an owner or admin).
async function end(req, id) {
  const { call, account } = await findCall(req, id);
  if (!LIVE_STATUSES.includes(call.status)) return serializeCall(call);
  if (call.memberId && String(call.memberId) !== String(req.member._id) && !isManager(req.member)) {
    throw httpError(403, 'FORBIDDEN', 'Only the teammate on this call, or an owner or admin, can end it.');
  }
  if (call.providerCallId) {
    await providerFor(account).callAction(accounts.credentials(account), { callId: call.providerCallId, action: 'terminate' })
      .catch((error) => logger.warn(`Ending WhatsApp call ${call.providerCallId} failed: ${error.message}`));
  }
  const now = new Date();
  const answered = call.status === 'in_progress';
  let status = 'completed';
  if (!answered) status = call.direction === 'out' ? 'cancelled' : 'no_answer';
  const done = await close(call, { status, durationSec: answered ? secondsBetween(call.whatsapp?.answeredAt, now) : 0 });
  return serializeCall(done || await Call.findById(call._id));
}

// POST /whatsapp-calls { conversationId, sdp } — call the customer of this chat.
async function place(req, { conversationId, sdp }) {
  const context = await conversationService.sendContext(req, conversationId, { needsWindow: false });
  const { conversation, account, contact } = context;
  if (!account.calling?.enabled) throw httpError(409, 'CALLING_OFF', 'WhatsApp calls are off for this number. An owner or admin switches them on in Settings → WhatsApp.');
  if (conversationService.callPermissionOf(conversation).status !== 'granted') {
    throw httpError(409, 'NO_CALL_PERMISSION', 'This customer has not allowed calls yet. Ask them first: they answer in the chat.');
  }
  const startedAt = new Date();
  const call = await Call.create({
    organizationId: conversation.organizationId, contactId: contact._id, leadId: (await openLeadOf(contact))?._id, memberId: req.member._id,
    direction: 'out', status: 'queued', provider: 'whatsapp', startedAt, fromNumber: account.displayPhone || '', toNumber: contact.phoneE164, createdById: req.user._id,
    whatsapp: { accountId: account._id, conversationId: conversation._id },
  });
  try {
    const placed = await providerFor(account).startCall(accounts.credentials(account), { to: contact.phoneE164.slice(1), sdp, tag: String(call._id) });
    call.providerCallId = placed.callId;
    await call.save();
  } catch (error) {
    await Call.updateOne({ _id: call._id }, { $set: { status: 'failed', error: str(error.message, 300), endedAt: new Date() } });
    await audit(req, { action: 'call.failed', entityType: 'Call', entityId: call._id, changes: { provider: 'whatsapp', error: str(error.message, 300) } });
    if (NO_PERMISSION_CODES.includes(Number(error.providerCode))) {
      await Conversation.updateOne({ _id: conversation._id }, { $unset: { callPermission: 1 } });
      throw httpError(409, 'NO_CALL_PERMISSION', 'WhatsApp says this customer has not allowed calls. Ask them first: they answer in the chat.');
    }
    throw httpError(error.statusCode === 400 ? 400 : 502, 'CALL_FAILED', `WhatsApp did not place the call: ${error.message}`);
  }
  const { conversation: chat } = await takeChat(conversation, req.member._id);
  await addLine(call, chat, startedAt);
  await audit(req, { action: 'call.dialled', entityType: 'Call', entityId: call._id, changes: { provider: 'whatsapp' } });
  return serializeCall(call);
}

// POST /whatsapp-calls/permission { conversationId, text } — asks the customer, in the chat, to
// allow calls (inside the 24-hour window). Meta allows one request a day and two a week.
async function askPermission(req, { conversationId, text }) {
  const conversation = await conversationService.findVisible(req, conversationId);
  const account = await WhatsAppAccount.findOne({ _id: conversation.whatsappAccountId, organizationId: conversation.organizationId });
  if (!account?.calling?.enabled) throw httpError(409, 'CALLING_OFF', 'WhatsApp calls are off for this number. An owner or admin switches them on in Settings → WhatsApp.');
  const permission = conversationService.callPermissionOf(conversation);
  if (permission.status === 'granted') throw httpError(409, 'ALREADY_ALLOWED', 'This customer already allows calls.');
  if (permission.requestedAt && Date.now() - permission.requestedAt.getTime() < DAY_MS) {
    throw httpError(409, 'ASKED_TODAY', 'You asked this customer today. WhatsApp allows one request a day (two a week).');
  }
  const message = await conversationService.sendCallPermissionRequest(req, conversationId, { text });
  if (message.status !== 'failed') {
    const updated = await Conversation.findOneAndUpdate(
      { _id: conversation._id },
      { $set: { 'callPermission.status': 'requested', 'callPermission.requestedAt': new Date() } },
      { returnDocument: 'after' },
    );
    conversationService.announce('conversation:updated', updated);
  }
  await audit(req, { action: 'call.permission_requested', entityType: 'Conversation', entityId: conversation._id });
  return message;
}

// --- the sweep: calls whose end never came (a lost webhook) are closed --------------------------
async function sweep(now = new Date()) {
  const stale = await Call.find({
    provider: 'whatsapp',
    $or: [
      { status: { $in: ['queued', 'ringing'] }, startedAt: { $lt: new Date(now.getTime() - RING_LIMIT_MS) } },
      { status: 'in_progress', startedAt: { $lt: new Date(now.getTime() - TALK_LIMIT_MS) } },
    ],
  }).limit(200);
  let closed = 0;
  for (const call of stale) {
    try {
      const done = await close(call, call.status === 'in_progress' ? { status: 'completed' } : { status: 'no_answer' });
      if (done) closed += 1;
    } catch (error) {
      logger.error(`Closing WhatsApp call ${call._id} failed: ${error.message}`);
    }
  }
  return { closed };
}

function register(queue) {
  queue.define(JOB, () => sweep(), { maxAttempts: 1 });
  queue.every(JOB, SWEEP_EVERY_MS).catch((error) => logger.error(`Scheduling ${JOB} failed: ${error.message}`));
}

module.exports = {
  JOB, setCalling, incoming, callEvent, callStatus, permissionReplied, ringing, get, answer, decline, end, place, askPermission, sweep, register, serializeCall,
};
