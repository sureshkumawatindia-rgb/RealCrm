const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const ScheduledMessage = require('../models/ScheduledMessage');
const httpError = require('../utils/httpError');
const logger = require('../config/logger');
const { audit } = require('../utils/audit');
const { isManager } = require('../constants/permissions');
const queue = require('../jobs/queue');
const notificationService = require('./notificationService');

// "Send later" (D103): a teammate writes a WhatsApp text now for a time of their choice (at least
// a minute and at most 30 days ahead). A job sends it then, as theirs — if the customer's 24-hour
// window is still open. If it closed, the text stays unsent and its writer gets a bell note to
// send an approved template instead. Until it goes it can be edited (a new version: the job of
// the old time does nothing) or cancelled. Blocking the customer cancels it.
const JOB = 'scheduled.send';
const MINUTE_MS = 60 * 1000;
const MAX_AHEAD_MS = 30 * 24 * 60 * MINUTE_MS;
const conversations = () => require('./conversationService'); // eslint-disable-line global-require -- it uses this service

function serialize(item) {
  return {
    id: item._id,
    conversationId: item.conversationId,
    text: item.text,
    sendAt: item.sendAt,
    status: item.status,
    memberId: item.memberId,
    memberName: item.memberName || '',
    messageId: item.messageId || null,
    error: item.error || '',
    createdAt: item.createdAt,
  };
}

function checkTime(sendAt) {
  const at = new Date(sendAt).getTime();
  if (!(at >= Date.now() + MINUTE_MS)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Pick a time at least a minute from now.', [{ field: 'sendAt', code: 'TOO_SOON', message: 'At least a minute from now.' }]);
  }
  if (at > Date.now() + MAX_AHEAD_MS) {
    throw httpError(400, 'VALIDATION_ERROR', 'Pick a time within the next 30 days.', [{ field: 'sendAt', code: 'TOO_LATE', message: 'Within the next 30 days.' }]);
  }
}

// When the customer's window will have closed by the time it goes, say so now.
function warningFor(conversation, sendAt) {
  const { expiresAt } = conversations().serviceWindow(conversation);
  if (expiresAt && new Date(sendAt) <= new Date(expiresAt)) return '';
  return 'The customer\'s 24-hour window will have closed by then unless they write again; if it is closed, the message will not go and you will be told.';
}

const runJob = (item) => queue.enqueue(JOB, { id: String(item._id), version: item.version }, {
  runAt: item.sendAt, uniqueKey: `scheduled:${item._id}:${item.version}`, organizationId: item.organizationId,
});

// GET /conversations/:id/scheduled — what waits to go in this chat.
async function list(req, conversationId) {
  const conversation = await conversations().findVisible(req, conversationId);
  const items = await ScheduledMessage.find({ organizationId: conversation.organizationId, conversationId: conversation._id, status: 'scheduled' }).sort({ sendAt: 1 });
  return items.map(serialize);
}

// POST /conversations/:id/scheduled { text, sendAt }
async function schedule(req, conversationId, { text, sendAt }) {
  const conversation = await conversations().findVisible(req, conversationId);
  conversations().assertNotBlocked(await Contact.findOne({ _id: conversation.contactId, organizationId: conversation.organizationId }).select('blocked'));
  checkTime(sendAt);
  const item = await ScheduledMessage.create({
    organizationId: conversation.organizationId, conversationId: conversation._id, contactId: conversation.contactId,
    memberId: req.member._id, memberName: req.user.name || '', text, sendAt,
  });
  await runJob(item);
  await audit(req, { action: 'message.scheduled', entityType: 'Conversation', entityId: conversation._id, changes: { scheduledMessageId: String(item._id), sendAt } });
  return { ...serialize(item), warning: warningFor(conversation, sendAt) };
}

// Its writer, or an owner or admin, may change or cancel it.
async function findOwn(req, id) {
  const item = await ScheduledMessage.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!item) throw httpError(404, 'NOT_FOUND', 'Scheduled message not found');
  await conversations().findVisible(req, item.conversationId);
  if (String(item.memberId) !== String(req.member._id) && !isManager(req.member)) {
    throw httpError(403, 'FORBIDDEN', 'Only the person who wrote it (or an owner or admin) can change it.');
  }
  if (item.status !== 'scheduled') throw httpError(409, 'NOT_SCHEDULED', item.status === 'cancelled' ? 'It was cancelled.' : 'It was already sent (or tried).');
  return item;
}

// PATCH /scheduled-messages/:id { text?, sendAt? }
async function update(req, id, { text, sendAt }) {
  const item = await findOwn(req, id);
  if (text !== undefined) item.text = text;
  if (sendAt !== undefined) {
    checkTime(sendAt);
    item.sendAt = sendAt;
  }
  item.version += 1;
  await item.save();
  await runJob(item);
  const conversation = await Conversation.findById(item.conversationId);
  return { ...serialize(item), warning: warningFor(conversation, item.sendAt) };
}

// DELETE /scheduled-messages/:id
async function cancel(req, id) {
  const item = await findOwn(req, id);
  item.status = 'cancelled';
  item.doneAt = new Date();
  await item.save();
  await audit(req, { action: 'message.schedule_cancelled', entityType: 'Conversation', entityId: item.conversationId, changes: { scheduledMessageId: String(item._id) } });
  return serialize(item);
}

const snippet = (text) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

async function tell(item, conversation, reason) {
  const contact = await Contact.findById(item.contactId).select('name phoneE164');
  await notificationService.notify(item.organizationId, [item.memberId], {
    title: 'Scheduled message not sent',
    body: `"${snippet(item.text)}" to ${contact?.name || 'the customer'} did not go: ${reason}`,
    link: `Inbox.html?c=${conversation?._id || item.conversationId}${reason.includes('template') ? '&template=1' : ''}`,
    source: 'inbox',
  });
}

// The job: this version, once, if the window is open.
async function sendDue({ id, version }) {
  const item = await ScheduledMessage.findOneAndUpdate({ _id: id, version, status: 'scheduled' }, { $set: { status: 'sending' } }, { returnDocument: 'after' });
  if (!item) return 'stale'; // edited, cancelled or sent meanwhile
  const conversation = await Conversation.findById(item.conversationId);
  const finish = async (status, extra = {}) => ScheduledMessage.updateOne({ _id: item._id }, { $set: { status, doneAt: new Date(), ...extra } });
  if (!conversation) {
    await finish('failed', { error: 'The chat was removed.' });
    return 'failed';
  }
  if (!conversations().serviceWindow(conversation).open) {
    await finish('window_closed', { error: 'The customer has not written in the last 24 hours.' });
    await tell(item, conversation, 'the customer has not written in the last 24 hours, so WhatsApp allows only an approved template. Open the chat to send one.');
    return 'window_closed';
  }
  try {
    const message = await conversations().sendScheduledText({ conversation, memberId: item.memberId, text: item.text });
    if (message.status === 'failed') {
      await finish('failed', { messageId: message.id, error: message.error?.message || 'WhatsApp did not take it.' });
      await tell(item, conversation, `WhatsApp did not take it (${message.error?.message || 'unknown reason'}).`);
      return 'failed';
    }
    await finish('sent', { messageId: message.id });
    return 'sent';
  } catch (error) {
    logger.warn(`Scheduled message ${item._id} not sent: ${error.message}`);
    await finish('failed', { error: error.message });
    await tell(item, conversation, error.message);
    return 'failed';
  }
}

function register(jobs) {
  jobs.define(JOB, sendDue, { maxAttempts: 1 });
}

module.exports = { JOB, list, schedule, update, cancel, sendDue, register, serialize };
