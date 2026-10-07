const Broadcast = require('../models/Broadcast');
const BroadcastRecipient = require('../models/BroadcastRecipient');
const Contact = require('../models/Contact');
const Message = require('../models/Message');
const MessageTemplate = require('../models/MessageTemplate');
const Organization = require('../models/Organization');
const Segment = require('../models/Segment');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const queue = require('../jobs/queue');
const bus = require('../realtime/bus');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { toPage, paginationMeta } = require('../utils/pagination');
const { estimateCost } = require('../constants/whatsappPricing');
const templateService = require('./templateService');
const conversations = require('./conversationService');
const notifications = require('./notificationService');
const segmentService = require('./segmentService');
const workflowService = require('./workflowService');
const planService = require('./planService');
const { resolveVariables } = require('./automation/actions');
const { loadContext, leadOfContact } = require('./automation/context');

// WhatsApp broadcasts (Phase 7, owners and admins). A draft names a template (its variables
// filled from each customer's details) and a segment. Starting it — now or at a set time —
// fixes the list of recipients (the segment's customers with a mobile number who have not opted
// out, D35) and sends in batches of 20 a second while Meta's daily limit allows (D38): Meta
// counts the different people who got a template in the last 24 hours, so the rest waits for
// room. WhatsApp's delivered / read / failed statuses and replies within 7 days update each
// recipient. The plan's monthly number of broadcasts is checked when starting (D34).
const JOBS = { START: 'broadcast.start', SEND: 'broadcast.send' };
const BATCH = 20;
const BATCH_PAUSE_MS = 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const REPLY_WINDOW = 7 * DAY;
// whatsapp_business_manager_messaging_limit → people per rolling 24 hours (unknown: the lowest).
const DAILY_LIMITS = { TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: Infinity };
const dailyLimitOf = (account) => DAILY_LIMITS[account?.messagingLimit] ?? 250;
const EDITABLE = ['draft', 'scheduled'];
const STOPPABLE = ['scheduled', 'sending', 'paused'];

const { monthStart } = planService;

// The plan's broadcasts this month (counted when they start).
async function quotaOf(organizationId) {
  const { plan, limit, used, left } = await planService.roomFor(organizationId, 'broadcastsPerMonth');
  return { plan, limit, used, left };
}

// People who got a template from this organization in the last 24 hours (as Meta counts them).
async function reachedToday(organizationId) {
  return (await Message.distinct('contactId', { organizationId, direction: 'out', type: 'template', status: { $ne: 'failed' }, createdAt: { $gte: new Date(Date.now() - DAY) } })).length;
}

async function audienceFilter(organizationId, segment) {
  return { $and: [await segmentService.contactFilter(organizationId, segment.filters), { phoneE164: { $type: 'string' } }] };
}

// sent counts every message WhatsApp took; delivered includes read and replied, read includes replied.
async function statsOf(broadcastIds) {
  const has = (field) => ({ $cond: [{ $ifNull: [`$${field}`, false] }, 1, 0] });
  const any = (...fields) => ({ $cond: [{ $or: fields.map((f) => ({ $ifNull: [`$${f}`, false] })) }, 1, 0] });
  const rows = await BroadcastRecipient.aggregate([
    { $match: { broadcastId: { $in: broadcastIds } } },
    {
      $group: {
        _id: '$broadcastId',
        total: { $sum: 1 },
        pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
        sent: { $sum: has('sentAt') },
        delivered: { $sum: any('deliveredAt', 'readAt', 'repliedAt') },
        read: { $sum: any('readAt', 'repliedAt') },
        replied: { $sum: has('repliedAt') },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        skipped: { $sum: { $cond: [{ $eq: ['$status', 'skipped'] }, 1, 0] } },
      },
    },
  ]);
  const empty = { total: 0, pending: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0 };
  return new Map(rows.map(({ _id, ...counts }) => [String(_id), counts])).set('empty', empty);
}

function serialize(broadcast, stats) {
  return {
    id: broadcast._id, name: broadcast.name, status: broadcast.status,
    template: { id: broadcast.templateId, name: broadcast.templateName, language: broadcast.templateLanguage, category: broadcast.category },
    variables: broadcast.variables || {}, segment: { id: broadcast.segmentId, name: broadcast.segmentName },
    scheduledAt: broadcast.scheduledAt || null, startedAt: broadcast.startedAt || null, finishedAt: broadcast.finishedAt || null,
    waitUntil: broadcast.waitUntil || null, estimate: broadcast.estimate || null, error: broadcast.error || '',
    stats: stats || { total: 0, pending: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0 },
    createdByName: broadcast.createdByName, createdAt: broadcast.createdAt, updatedAt: broadcast.updatedAt,
  };
}

async function find(req, id) {
  const broadcast = await Broadcast.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!broadcast) throw httpError(404, 'NOT_FOUND', 'Broadcast not found');
  return broadcast;
}

async function withStats(broadcast) {
  const stats = await statsOf([broadcast._id]);
  return serialize(broadcast, stats.get(String(broadcast._id)) || stats.get('empty'));
}

// The template must be sendable with every variable given (same rules as workflow steps).
async function checkContent(req, { templateId, variables, segmentId }) {
  await workflowService.checkTemplateStep(req, { templateId, variables });
  const [template, segment] = await Promise.all([
    MessageTemplate.findOne({ _id: templateId, organizationId: req.tenant.organizationId }),
    Segment.findOne({ _id: segmentId, organizationId: req.tenant.organizationId }),
  ]);
  if (!segment) throw httpError(400, 'VALIDATION_ERROR', 'Pick one of your segments.', [{ field: 'segmentId', code: 'INVALID_SEGMENT', message: 'Pick one of your segments.' }]);
  return { template, segment };
}

// --- the API ----------------------------------------------------------------------------------
async function list(req, query) {
  const filter = { organizationId: req.tenant.organizationId, ...(query.status && { status: query.status }) };
  const page = toPage(query);
  const [items, total] = await Promise.all([Broadcast.find(filter).sort({ createdAt: -1 }).skip(page.skip).limit(page.limit), Broadcast.countDocuments(filter)]);
  const stats = await statsOf(items.map((b) => b._id));
  return { items: items.map((b) => serialize(b, stats.get(String(b._id)) || stats.get('empty'))), pagination: paginationMeta(page, total) };
}

async function create(req, body) {
  const { template, segment } = await checkContent(req, body);
  const broadcast = await Broadcast.create({
    organizationId: req.tenant.organizationId, name: body.name, templateId: template._id, templateName: template.name, templateLanguage: template.language,
    category: String(template.category || '').toUpperCase(), whatsappAccountId: template.whatsappAccountId, variables: body.variables || {},
    segmentId: segment._id, segmentName: segment.name, createdById: req.user._id, createdByName: req.user.name || '',
  });
  await audit(req, { action: 'broadcast.created', entityType: 'Broadcast', entityId: broadcast._id });
  return withStats(broadcast);
}

async function update(req, id, body) {
  const broadcast = await find(req, id);
  if (!EDITABLE.includes(broadcast.status)) throw httpError(409, 'BROADCAST_STARTED', 'A broadcast that has started cannot be changed.');
  const next = { templateId: body.templateId || broadcast.templateId, variables: body.variables || broadcast.variables, segmentId: body.segmentId || broadcast.segmentId };
  const { template, segment } = await checkContent(req, next);
  Object.assign(broadcast, {
    ...(body.name && { name: body.name }), templateId: template._id, templateName: template.name, templateLanguage: template.language,
    category: String(template.category || '').toUpperCase(), whatsappAccountId: template.whatsappAccountId, variables: next.variables, segmentId: segment._id, segmentName: segment.name,
  });
  broadcast.markModified('variables');
  await broadcast.save();
  await audit(req, { action: 'broadcast.updated', entityType: 'Broadcast', entityId: broadcast._id, changes: Object.keys(body) });
  return withStats(broadcast);
}

async function remove(req, id) {
  const broadcast = await find(req, id);
  if (!['draft', 'cancelled'].includes(broadcast.status)) throw httpError(409, 'BROADCAST_STARTED', 'Only drafts and cancelled broadcasts can be deleted; the others are your sending record.');
  await BroadcastRecipient.deleteMany({ broadcastId: broadcast._id });
  await broadcast.deleteOne();
  await audit(req, { action: 'broadcast.deleted', entityType: 'Broadcast', entityId: broadcast._id });
}

// Who it would reach now, what it may cost, and the limits — before sending.
async function estimate(req, id) {
  const broadcast = await find(req, id);
  const segment = await Segment.findOne({ _id: broadcast.segmentId, organizationId: req.tenant.organizationId });
  const recipients = segment ? await Contact.countDocuments(await audienceFilter(req.tenant.organizationId, segment)) : 0;
  const account = await WhatsAppAccount.findOne({ _id: broadcast.whatsappAccountId, organizationId: req.tenant.organizationId });
  const dailyLimit = dailyLimitOf(account);
  const usedToday = await reachedToday(req.tenant.organizationId);
  return {
    recipients,
    cost: estimateCost(recipients, broadcast.category),
    quota: await quotaOf(req.tenant.organizationId),
    dailyLimit: { limit: Number.isFinite(dailyLimit) ? dailyLimit : null, tier: account?.messagingLimit || '', usedToday, leftToday: Number.isFinite(dailyLimit) ? Math.max(dailyLimit - usedToday, 0) : null },
  };
}

// Now, or at scheduledAt (a future time). Drafts and scheduled ones (to change the time).
async function send(req, id, { scheduledAt }) {
  const broadcast = await find(req, id);
  if (!EDITABLE.includes(broadcast.status)) throw httpError(409, 'BROADCAST_STARTED', 'This broadcast has already started.');
  await checkContent(req, broadcast);
  await planService.assertActive(req.tenant.organizationId, 'send broadcasts');
  const quota = await quotaOf(req.tenant.organizationId);
  if (!quota.left) throw httpError(409, 'QUOTA_REACHED', `Your ${quota.plan} plan allows ${quota.limit} broadcasts a month; this month's are used up.`);
  const segment = await Segment.findById(broadcast.segmentId);
  if (!(await Contact.countDocuments(await audienceFilter(req.tenant.organizationId, segment)))) {
    throw httpError(409, 'EMPTY_AUDIENCE', `Nobody in "${segment.name}" can get it (a mobile number is needed and opted-out customers are left out).`);
  }
  const at = scheduledAt && new Date(scheduledAt) > new Date() ? new Date(scheduledAt) : new Date();
  await queue.cancel(`broadcast:start:${broadcast._id}`);
  broadcast.status = 'scheduled';
  broadcast.scheduledAt = at;
  await broadcast.save();
  await queue.enqueue(JOBS.START, { broadcastId: String(broadcast._id) }, { runAt: at, uniqueKey: `broadcast:start:${broadcast._id}`, organizationId: broadcast.organizationId, maxAttempts: 3 });
  await audit(req, { action: 'broadcast.scheduled', entityType: 'Broadcast', entityId: broadcast._id, changes: { scheduledAt: at } });
  return withStats(broadcast);
}

async function cancel(req, id) {
  const broadcast = await find(req, id);
  if (!STOPPABLE.includes(broadcast.status)) throw httpError(409, 'NOT_RUNNING', 'Only a scheduled or sending broadcast can be cancelled.');
  await queue.cancel(`broadcast:start:${broadcast._id}`);
  broadcast.status = 'cancelled';
  broadcast.finishedAt = new Date();
  await broadcast.save();
  await BroadcastRecipient.updateMany({ broadcastId: broadcast._id, status: 'pending' }, { $set: { status: 'skipped', reason: 'The broadcast was cancelled.' } });
  await audit(req, { action: 'broadcast.cancelled', entityType: 'Broadcast', entityId: broadcast._id });
  return withStats(broadcast);
}

async function pause(req, id) {
  const broadcast = await find(req, id);
  if (broadcast.status !== 'sending') throw httpError(409, 'NOT_SENDING', 'Only a broadcast that is sending can be paused.');
  broadcast.status = 'paused';
  await broadcast.save();
  return withStats(broadcast);
}

async function resume(req, id) {
  const broadcast = await find(req, id);
  if (broadcast.status !== 'paused') throw httpError(409, 'NOT_PAUSED', 'This broadcast is not paused.');
  broadcast.status = 'sending';
  await broadcast.save();
  await nextBatch(broadcast, new Date());
  return withStats(broadcast);
}

async function recipients(req, id, query) {
  const broadcast = await find(req, id);
  const filter = { broadcastId: broadcast._id, ...(query.status && { status: query.status }) };
  const page = toPage(query);
  const [items, total] = await Promise.all([BroadcastRecipient.find(filter).sort({ updatedAt: -1 }).skip(page.skip).limit(page.limit), BroadcastRecipient.countDocuments(filter)]);
  return {
    items: items.map((r) => ({
      id: r._id, contactId: r.contactId, name: r.name, phone: r.phoneE164, status: r.status, reason: r.reason, conversationId: r.conversationId || null,
      sentAt: r.sentAt || null, deliveredAt: r.deliveredAt || null, readAt: r.readAt || null, repliedAt: r.repliedAt || null, failedAt: r.failedAt || null,
    })),
    pagination: paginationMeta(page, total),
  };
}

// --- the jobs ---------------------------------------------------------------------------------
async function nextBatch(broadcast, runAt) {
  const updated = await Broadcast.findOneAndUpdate({ _id: broadcast._id }, { $inc: { batches: 1 } }, { returnDocument: 'after' });
  await queue.enqueue(JOBS.SEND, { broadcastId: String(broadcast._id) }, { runAt, uniqueKey: `broadcast:send:${broadcast._id}:${updated.batches}`, organizationId: broadcast.organizationId, maxAttempts: 3 });
}

async function fail(broadcast, error) {
  broadcast.status = 'failed';
  broadcast.error = error;
  broadcast.finishedAt = new Date();
  await broadcast.save();
  await BroadcastRecipient.updateMany({ broadcastId: broadcast._id, status: 'pending' }, { $set: { status: 'skipped', reason: error } });
}

// Fixes the recipients and starts sending.
async function start({ broadcastId }) {
  const broadcast = await Broadcast.findById(broadcastId);
  if (!broadcast || broadcast.status !== 'scheduled') return;
  const organizationId = broadcast.organizationId;
  if (planService.subscriptionOf(await Organization.findById(organizationId)).locked) return fail(broadcast, 'Not sent: the subscription is not active (Settings → Plan & usage).');
  const quota = await quotaOf(organizationId);
  if (!quota.left) return fail(broadcast, `Not sent: your ${quota.plan} plan's ${quota.limit} broadcasts for this month were used up.`);
  const template = await MessageTemplate.findOne({ _id: broadcast.templateId, organizationId });
  const shape = template ? templateService.shapeOf(template) : null;
  if (!shape?.sendable) return fail(broadcast, `Not sent: the template ${template ? `cannot be sent (${shape.notSendableReason})` : 'was removed'}.`);
  const segment = await Segment.findOne({ _id: broadcast.segmentId, organizationId });
  if (!segment) return fail(broadcast, 'Not sent: the segment was removed.');

  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    await BroadcastRecipient.insertMany(batch, { ordered: false }).catch((error) => {
      if (error.code !== 11000 && !error.writeErrors) throw error; // a retried start: already there
    });
    batch = [];
  };
  for await (const contact of Contact.find(await audienceFilter(organizationId, segment)).select('name phoneE164').cursor()) {
    batch.push({ organizationId, broadcastId: broadcast._id, contactId: contact._id, name: contact.name, phoneE164: contact.phoneE164 });
    if (batch.length >= 1000) await flush();
  }
  await flush();
  const total = await BroadcastRecipient.countDocuments({ broadcastId: broadcast._id });
  broadcast.status = 'sending';
  broadcast.startedAt = new Date();
  broadcast.estimate = estimateCost(total, broadcast.category);
  await broadcast.save();
  await nextBatch(broadcast, new Date());
}

// One customer: checked again (opted out since? a value missing?), then the template goes into
// their chat (opened if needed, for their owner).
async function sendOne(broadcast, template, account, recipient) {
  const skip = (reason) => BroadcastRecipient.updateOne({ _id: recipient._id }, { $set: { status: 'skipped', reason } });
  const contact = await Contact.findOne({ _id: recipient.contactId, organizationId: broadcast.organizationId, deletedAt: null });
  if (!contact?.phoneE164) return skip(contact ? 'No mobile number any more.' : 'The customer was removed.');
  if (contact.consent?.marketing === 'opted_out') return skip('Opted out of WhatsApp offers.');
  const lead = await leadOfContact(broadcast.organizationId, contact._id);
  const ctx = await loadContext({ organizationId: broadcast.organizationId, subject: { contactId: contact._id, ...(lead && { leadId: lead._id }) } });
  const variables = resolveVariables(broadcast.variables, ctx);
  const missing = Object.values(variables).flatMap((values) => Object.entries(values).filter(([, v]) => !String(v).trim()).map(([name]) => `{{${name}}}`));
  if (missing.length) return skip(`No value for ${missing.join(', ')}.`);
  try {
    const conversation = await conversations.ensureConversation({ organizationId: broadcast.organizationId, contactId: contact._id, accountId: account._id, assigneeId: contact.ownerId || null });
    const message = await conversations.sendTemplateAutomatically({ conversation, template, variables, automation: { kind: 'broadcast', ruleId: broadcast._id } });
    if (message.status === 'failed') {
      return BroadcastRecipient.updateOne({ _id: recipient._id }, { $set: { status: 'failed', failedAt: new Date(), reason: message.error?.message || 'WhatsApp refused it.', messageId: message.id, conversationId: conversation._id } });
    }
    return BroadcastRecipient.updateOne({ _id: recipient._id }, { $set: { status: 'sent', sentAt: new Date(), messageId: message.id, conversationId: conversation._id } });
  } catch (error) {
    return BroadcastRecipient.updateOne({ _id: recipient._id }, { $set: { status: 'failed', failedAt: new Date(), reason: String(error.message || error).slice(0, 300) } });
  }
}

async function sendBatch({ broadcastId }) {
  const broadcast = await Broadcast.findById(broadcastId);
  if (!broadcast || broadcast.status !== 'sending') return;
  const organizationId = broadcast.organizationId;
  const [template, account] = await Promise.all([
    MessageTemplate.findOne({ _id: broadcast.templateId, organizationId }),
    WhatsAppAccount.findOne({ _id: broadcast.whatsappAccountId, organizationId }),
  ]);
  if (!template || !account) return fail(broadcast, `Stopped: the ${template ? 'WhatsApp number' : 'template'} was removed.`);

  // Meta's daily limit: wait for room when it is used up.
  const limit = dailyLimitOf(account);
  const left = Number.isFinite(limit) ? limit - (await reachedToday(organizationId)) : BATCH;
  if (left <= 0) {
    const oldest = await Message.findOne({ organizationId, direction: 'out', type: 'template', status: { $ne: 'failed' }, createdAt: { $gte: new Date(Date.now() - DAY) } }).sort({ createdAt: 1 });
    broadcast.waitUntil = new Date((oldest ? oldest.createdAt.getTime() + DAY : Date.now() + HOUR) + 60 * 1000);
    await broadcast.save();
    return nextBatch(broadcast, broadcast.waitUntil);
  }
  const pending = await BroadcastRecipient.find({ broadcastId: broadcast._id, status: 'pending' }).limit(Math.min(BATCH, left));
  if (!pending.length) {
    broadcast.status = 'completed';
    broadcast.finishedAt = new Date();
    broadcast.waitUntil = undefined;
    await broadcast.save();
    const stats = (await statsOf([broadcast._id])).get(String(broadcast._id));
    const createdBy = await require('../models/OrganizationMember').findOne({ organizationId, userId: broadcast.createdById, status: 'active' }); // eslint-disable-line global-require
    if (createdBy) {
      await notifications.notify(organizationId, [createdBy._id], {
        title: `Broadcast "${broadcast.name}" sent`, body: `${stats?.sent || 0} sent · ${stats?.failed || 0} failed · ${stats?.skipped || 0} skipped`, link: `Marketing.html?broadcast=${broadcast._id}`, source: 'broadcast',
      });
    }
    return undefined;
  }
  if (broadcast.waitUntil) {
    broadcast.waitUntil = undefined;
    await broadcast.save();
  }
  for (const recipient of pending) await sendOne(broadcast, template, account, recipient);
  return nextBatch(broadcast, new Date(Date.now() + BATCH_PAUSE_MS));
}

// WhatsApp's statuses for broadcast messages (the timestamps only move forward).
async function onMessageStatus({ message }) {
  if (message?.automation?.kind !== 'broadcast') return;
  const at = message[`${message.status}At`] || new Date();
  if (message.status === 'delivered') {
    await BroadcastRecipient.updateOne({ messageId: message._id, deliveredAt: null }, { $set: { deliveredAt: at } });
    await BroadcastRecipient.updateOne({ messageId: message._id, status: 'sent' }, { $set: { status: 'delivered' } });
  } else if (message.status === 'read') {
    await BroadcastRecipient.updateOne({ messageId: message._id, deliveredAt: null }, { $set: { deliveredAt: at } });
    await BroadcastRecipient.updateOne({ messageId: message._id, readAt: null }, { $set: { readAt: at } });
    await BroadcastRecipient.updateOne({ messageId: message._id, status: { $in: ['sent', 'delivered'] } }, { $set: { status: 'read' } });
  } else if (message.status === 'failed') {
    await BroadcastRecipient.updateOne({ messageId: message._id }, { $set: { status: 'failed', failedAt: at, reason: message.error?.message || message.error?.title || 'WhatsApp could not deliver it.' } });
  }
}

// A customer wrote back within 7 days of a broadcast.
async function handleReply(event) {
  if (event.type !== 'message.received' || !event.contactId) return 0;
  const { modifiedCount } = await BroadcastRecipient.updateMany(
    { organizationId: event.organizationId, contactId: event.contactId, sentAt: { $gte: new Date(Date.now() - REPLY_WINDOW) }, repliedAt: null, status: { $in: ['sent', 'delivered', 'read'] } },
    { $set: { status: 'replied', repliedAt: new Date() } },
  );
  return modifiedCount;
}

let listener = null;
function register(jobQueue) {
  jobQueue.define(JOBS.START, (data) => start(data), { maxAttempts: 3 });
  jobQueue.define(JOBS.SEND, (data) => sendBatch(data), { maxAttempts: 3 });
  if (listener) bus.off('message:status', listener);
  listener = (payload) => onMessageStatus(payload).catch((error) => logger.error(`Broadcast status update failed: ${error.message}`));
  bus.on('message:status', listener);
}

module.exports = {
  JOBS, register, list, create, update, remove, estimate, send, cancel, pause, resume, recipients, handleReply, onMessageStatus,
  get: async (req, id) => withStats(await find(req, id)),
  quota: (req) => quotaOf(req.tenant.organizationId),
  monthStart, dailyLimitOf, statsOf,
};
