const Broadcast = require('../models/Broadcast');
const BroadcastRecipient = require('../models/BroadcastRecipient');
const Contact = require('../models/Contact');
const Message = require('../models/Message');
const SmsMessage = require('../models/SmsMessage');
const WebhookDelivery = require('../models/WebhookDelivery');
const WebhookSubscription = require('../models/WebhookSubscription');
const httpError = require('../utils/httpError');
const conversationService = require('./conversationService');
const smsService = require('./smsService');
const webhooks = require('./outboundWebhookService');

// Settings → Failed sends (Phase 9, D151; owners and admins): everything of the last 7 days that
// did not go — chat messages (failed, or waiting for their next try), SMS, webhooks to the
// company's own systems, broadcasts with failed deliveries — on one list, with the reason and
// "Try again". A private number's messages (D61) are for owners only.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

function chatFilter(req, since) {
  return {
    organizationId: req.tenant.organizationId,
    direction: 'out',
    createdAt: { $gte: since },
    'automation.kind': { $ne: 'broadcast' }, // those are the broadcast's own line
    $or: [{ status: 'failed' }, { status: 'queued', 'retry.nextAt': { $ne: null } }],
    ...(req.member.role !== 'owner' && { private: { $ne: true } }),
  };
}

const namesOf = async (organizationId, ids) => {
  if (!ids.length) return new Map();
  const contacts = await Contact.collection.find({ organizationId, _id: { $in: ids } }).project({ name: 1 }).toArray();
  return new Map(contacts.map((c) => [String(c._id), c.name]));
};

async function chatItems(req, since, count) {
  const messages = await Message.find(chatFilter(req, since)).sort({ createdAt: -1 }).limit(count);
  const names = await namesOf(req.tenant.organizationId, [...new Set(messages.map((m) => String(m.contactId)))].map((id) => messages.find((m) => String(m.contactId) === id).contactId));
  return messages.map((m) => ({
    kind: 'chat', id: String(m._id), at: m.createdAt, channel: m.channel || 'whatsapp', state: m.status === 'failed' ? 'failed' : 'waiting',
    customer: names.get(String(m.contactId)) || '', conversationId: String(m.conversationId),
    what: m.text || m.media?.fileName || m.template?.name || m.type,
    reason: m.error?.message || m.error?.title || m.retry?.lastError || '', stopped: m.error?.title === 'stopped', nextAt: m.retry?.nextAt || null, automatic: Boolean(m.automation?.kind),
    canRetry: conversationService.canRetry(m),
  }));
}

async function smsItems(req, since, count) {
  const filter = { organizationId: req.tenant.organizationId, direction: 'out', status: 'failed', createdAt: { $gte: since } };
  const messages = await SmsMessage.find(filter).sort({ createdAt: -1 }).limit(count).lean();
  const names = await namesOf(req.tenant.organizationId, messages.map((m) => m.contactId).filter(Boolean));
  return messages.map((m) => ({
    kind: 'sms', id: String(m._id), at: m.createdAt, state: 'failed', customer: names.get(String(m.contactId)) || m.to || '', contactId: m.contactId ? String(m.contactId) : null,
    what: m.text || m.templateName || '', reason: m.error || '', canRetry: Boolean(m.values),
  }));
}

async function webhookItems(req, since, count) {
  const filter = { organizationId: req.tenant.organizationId, status: 'failed', createdAt: { $gte: since } };
  const deliveries = await WebhookDelivery.find(filter).sort({ createdAt: -1 }).limit(count).lean();
  const subs = await WebhookSubscription.find({ organizationId: req.tenant.organizationId, _id: { $in: [...new Set(deliveries.map((d) => String(d.subscriptionId)))] } }).select('url description').lean();
  const byId = new Map(subs.map((s) => [String(s._id), s]));
  return deliveries.map((d) => {
    const sub = byId.get(String(d.subscriptionId));
    return {
      kind: 'webhook', id: String(d._id), at: d.createdAt, state: 'failed', customer: sub?.description || hostOf(sub?.url) || '', what: d.event,
      reason: d.error || (d.responseCode ? `HTTP ${d.responseCode}` : ''), canRetry: Boolean(sub),
    };
  });
}

// One line per broadcast with failed deliveries (its own page has who and why).
async function broadcastItems(req, since, count) {
  const rows = await BroadcastRecipient.aggregate([
    { $match: { organizationId: req.tenant.organizationId, status: 'failed', failedAt: { $gte: since } } },
    { $group: { _id: '$broadcastId', count: { $sum: 1 }, at: { $max: '$failedAt' }, reason: { $last: '$reason' } } },
    { $sort: { at: -1 } },
    { $limit: count },
  ]);
  const broadcasts = await Broadcast.find({ organizationId: req.tenant.organizationId, _id: { $in: rows.map((r) => r._id) } }).select('name').lean();
  const names = new Map(broadcasts.map((b) => [String(b._id), b.name]));
  return rows.map((r) => ({ kind: 'broadcast', id: String(r._id), at: r.at, state: 'failed', customer: names.get(String(r._id)) || '', what: '', count: r.count, reason: r.reason || '', canRetry: false }));
}

const COUNTS = {
  async chat(req, since) {
    const base = chatFilter(req, since);
    delete base.$or;
    const [failed, waiting] = await Promise.all([
      Message.countDocuments({ ...base, status: 'failed' }),
      Message.countDocuments({ ...base, status: 'queued', 'retry.nextAt': { $ne: null } }),
    ]);
    return { failed, waiting };
  },
  sms: async (req, since) => ({ failed: await SmsMessage.countDocuments({ organizationId: req.tenant.organizationId, direction: 'out', status: 'failed', createdAt: { $gte: since } }), waiting: 0 }),
  webhook: async (req, since) => ({ failed: await WebhookDelivery.countDocuments({ organizationId: req.tenant.organizationId, status: 'failed', createdAt: { $gte: since } }), waiting: 0 }),
  broadcast: async (req, since) => ({ failed: (await BroadcastRecipient.distinct('broadcastId', { organizationId: req.tenant.organizationId, status: 'failed', failedAt: { $gte: since } })).length, waiting: 0 }),
};
const LISTS = { chat: chatItems, sms: smsItems, webhook: webhookItems, broadcast: broadcastItems };
const KINDS = Object.keys(LISTS);

// GET /delivery-problems?kind=&page=&limit=
async function list(req, { kind = 'all', page = 1, limit = 30 } = {}) {
  const since = new Date(Date.now() - WEEK_MS);
  const kinds = kind === 'all' ? KINDS : [kind];
  const counts = Object.fromEntries(await Promise.all(KINDS.map(async (k) => [k, await COUNTS[k](req, since)])));
  const lists = await Promise.all(kinds.map((k) => LISTS[k](req, since, page * limit)));
  const items = lists.flat().sort((a, b) => new Date(b.at) - new Date(a.at)).slice((page - 1) * limit, page * limit);
  const total = kinds.reduce((n, k) => n + counts[k].failed + counts[k].waiting, 0);
  return {
    items,
    summary: { failed: KINDS.reduce((n, k) => n + counts[k].failed, 0), waiting: KINDS.reduce((n, k) => n + counts[k].waiting, 0), counts },
    pagination: { page, limit, total, pages: Math.ceil(total / limit), hasNextPage: page * limit < total },
  };
}

// POST /delivery-problems/:kind/:id/retry
async function retry(req, kind, id) {
  if (kind === 'chat') {
    const message = await Message.findOne({ _id: id, organizationId: req.tenant.organizationId, direction: 'out' }).select('conversationId');
    if (!message) throw httpError(404, 'NOT_FOUND', 'Message not found');
    return conversationService.retryFailed(req, message.conversationId, id);
  }
  if (kind === 'sms') return smsService.retryFailed(req, id);
  if (kind === 'webhook') return webhooks.retry(req, id);
  throw httpError(409, 'CANNOT_RESEND', 'This cannot be sent again from here.');
}

module.exports = { list, retry, KINDS };
