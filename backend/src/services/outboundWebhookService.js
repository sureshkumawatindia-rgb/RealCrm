const crypto = require('crypto');
const mongoose = require('mongoose');
const WebhookSubscription = require('../models/WebhookSubscription');
const WebhookDelivery = require('../models/WebhookDelivery');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Lead = require('../models/Lead');
const Contact = require('../models/Contact');
const Quotation = require('../models/Quotation');
const Order = require('../models/Order');
const Message = require('../models/Message');
const bus = require('../realtime/bus');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { encrypt, decrypt } = require('../utils/secretBox');
const { assertPublicHttps } = require('../utils/safeWebhook');
const { toPage, paginationMeta } = require('../utils/pagination');
const { WEBHOOK_EVENTS, WEBHOOK_EVENT_KEYS } = require('../constants/api');
const planService = require('./planService');
const notificationService = require('./notificationService');
const publicApi = require('./publicApiService');

// Outbound webhooks (Phase 10C, Settings → API & webhooks, owners and admins): the CRM's
// business events (lead created, stage changed, message received, order, payment …) are POSTed
// as JSON to the company's https addresses, signed with each address's own secret:
//   X-CRM-Signature: sha256=<hex HMAC-SHA256 of the raw body>, X-CRM-Event, X-CRM-Delivery,
//   X-CRM-Event-Id (the same for every attempt: the receiver drops repeats).
// A failed delivery is tried again after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h and 24 h; after 25
// failed deliveries in a row the address is switched off and owners and admins are told.
// Needs a plan with the API (Growth and up).
const JOBS = { FANOUT: 'webhook.fanout', DELIVER: 'webhook.deliver' };
const RETRY_AFTER_MS = [60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3];
const MAX_ATTEMPTS = RETRY_AFTER_MS.length + 1;
const DISABLE_AFTER_FAILURES = 25;
const MAX_SUBSCRIPTIONS = 20;
const TIMEOUT_MS = 10000;

const newSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`;
const eventIdOf = (key) => `evt_${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24)}`;

function serialize(sub) {
  return {
    id: sub._id, url: sub.url, events: sub.events, description: sub.description, active: sub.active,
    disabledReason: sub.disabledReason || '', failuresInARow: sub.failuresInARow || 0,
    lastDeliveryAt: sub.lastDeliveryAt || null, lastStatus: sub.lastStatus || null, lastResponseCode: sub.lastResponseCode ?? null,
    createdAt: sub.createdAt,
  };
}

function serializeDelivery(d) {
  return {
    id: d._id, eventId: d.eventId, event: d.event, status: d.status, attempts: d.attempts, nextAttemptAt: d.nextAttemptAt || null,
    responseCode: d.responseCode ?? null, responseBody: d.responseBody || '', error: d.error || '', durationMs: d.durationMs ?? null,
    deliveredAt: d.deliveredAt || null, createdAt: d.createdAt, payload: d.payload,
  };
}

async function findInOrg(req, id) {
  const sub = mongoose.isValidObjectId(id) ? await WebhookSubscription.findOne({ _id: id, organizationId: req.tenant.organizationId }) : null;
  if (!sub) throw httpError(404, 'NOT_FOUND', 'Webhook not found');
  return sub;
}

// --- settings ----------------------------------------------------------------------------------
async function list(req) {
  return (await WebhookSubscription.find({ organizationId: req.tenant.organizationId }).sort({ createdAt: -1 }).limit(MAX_SUBSCRIPTIONS)).map(serialize);
}

async function create(req, { url, events, description = '' }) {
  await planService.assertFeature(req.tenant.organizationId, 'api');
  await assertPublicHttps(url);
  if (await WebhookSubscription.countDocuments({ organizationId: req.tenant.organizationId }) >= MAX_SUBSCRIPTIONS) {
    throw httpError(409, 'TOO_MANY_WEBHOOKS', `A company can have ${MAX_SUBSCRIPTIONS} webhooks.`);
  }
  const secret = newSecret();
  const sub = await WebhookSubscription.create({ organizationId: req.tenant.organizationId, url, events, description, secretEnc: encrypt(secret), createdById: req.user._id });
  await audit(req, { action: 'webhook.created', entityType: 'WebhookSubscription', entityId: sub._id, changes: { url, events } });
  return { ...serialize(sub), secret };
}

async function update(req, id, patch) {
  const sub = await findInOrg(req, id);
  if (patch.url) await assertPublicHttps(patch.url);
  if (patch.active) await planService.assertFeature(req.tenant.organizationId, 'api');
  Object.assign(sub, patch);
  if (patch.active) Object.assign(sub, { failuresInARow: 0, disabledReason: '' });
  await sub.save();
  if (patch.active === false) await WebhookDelivery.updateMany({ subscriptionId: sub._id, status: 'pending' }, { $set: { status: 'cancelled', error: 'The webhook was switched off.' } });
  await audit(req, { action: 'webhook.updated', entityType: 'WebhookSubscription', entityId: sub._id, changes: Object.keys(patch) });
  return serialize(sub);
}

async function remove(req, id) {
  const sub = await findInOrg(req, id);
  await WebhookDelivery.updateMany({ subscriptionId: sub._id, status: 'pending' }, { $set: { status: 'cancelled', error: 'The webhook was removed.' } });
  await sub.deleteOne();
  await audit(req, { action: 'webhook.removed', entityType: 'WebhookSubscription', entityId: sub._id, changes: { url: sub.url } });
}

async function rotateSecret(req, id) {
  const sub = await findInOrg(req, id);
  const secret = newSecret();
  sub.secretEnc = encrypt(secret);
  await sub.save();
  await audit(req, { action: 'webhook.secret_rotated', entityType: 'WebhookSubscription', entityId: sub._id });
  return { ...serialize(sub), secret };
}

async function listDeliveries(req, id, query) {
  const sub = await findInOrg(req, id);
  const page = toPage(query);
  const filter = { subscriptionId: sub._id, ...(query.status && { status: query.status }) };
  const [items, total] = await Promise.all([
    WebhookDelivery.find(filter).sort({ createdAt: -1 }).skip(page.skip).limit(page.limit),
    WebhookDelivery.countDocuments(filter),
  ]);
  return { items: items.map(serializeDelivery), pagination: paginationMeta(page, total) };
}

// --- sending -----------------------------------------------------------------------------------
// One signed POST. → { ok, status, body, ms, error }. An address that is not public https is
// refused (no retry).
async function post(sub, delivery) {
  const body = JSON.stringify(delivery.payload);
  const secret = decrypt(sub.secretEnc);
  const started = Date.now();
  let url;
  try {
    url = await assertPublicHttps(sub.url);
  } catch (error) {
    return { ok: false, refused: true, error: error.message, ms: 0 };
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'YellowCRM-Webhooks/1',
        'X-CRM-Event': delivery.event,
        'X-CRM-Event-Id': delivery.eventId,
        'X-CRM-Delivery': String(delivery._id),
        'X-CRM-Signature': `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = (await response.text().catch(() => '')).slice(0, 500);
    return { ok: response.status >= 200 && response.status < 300, status: response.status, body: text, ms: Date.now() - started, error: response.status >= 300 ? `Answered ${response.status}` : '' };
  } catch (error) {
    return { ok: false, error: error.name === 'TimeoutError' ? 'No answer within 10 seconds' : 'Could not connect', ms: Date.now() - started };
  }
}

async function managersOf(organizationId) {
  return (await OrganizationMember.find({ organizationId, status: 'active', role: { $in: ['owner', 'admin'] } }).select('_id')).map((m) => m._id);
}

async function recordResult(sub, delivery, result, queue) {
  const now = new Date();
  const attempts = delivery.attempts + 1;
  const base = { attempts, responseCode: result.status ?? null, responseBody: result.body || '', error: result.error || '', durationMs: result.ms };
  if (result.ok) {
    await WebhookDelivery.updateOne({ _id: delivery._id }, { $set: { ...base, status: 'delivered', deliveredAt: now }, $unset: { nextAttemptAt: 1 } });
    await WebhookSubscription.updateOne({ _id: sub._id }, { $set: { failuresInARow: 0, lastDeliveryAt: now, lastStatus: 'delivered', lastResponseCode: result.status } });
    return 'delivered';
  }
  const retry = !result.refused && attempts < MAX_ATTEMPTS && queue;
  if (retry) {
    const runAt = new Date(now.getTime() + RETRY_AFTER_MS[attempts - 1]);
    await WebhookDelivery.updateOne({ _id: delivery._id }, { $set: { ...base, status: 'pending', nextAttemptAt: runAt } });
    await queue.enqueue(JOBS.DELIVER, { deliveryId: String(delivery._id) }, { runAt, uniqueKey: `webhook.deliver:${delivery._id}:${attempts}`, organizationId: delivery.organizationId, maxAttempts: 2 });
  } else {
    await WebhookDelivery.updateOne({ _id: delivery._id }, { $set: { ...base, status: 'failed' }, $unset: { nextAttemptAt: 1 } });
  }
  const updated = await WebhookSubscription.findOneAndUpdate(
    { _id: sub._id },
    { ...(!retry && { $inc: { failuresInARow: 1 } }), $set: { lastDeliveryAt: now, lastStatus: 'failed', lastResponseCode: result.status ?? null } },
    { returnDocument: 'after' },
  );
  if (updated && updated.active && updated.failuresInARow >= DISABLE_AFTER_FAILURES) {
    const disabled = await WebhookSubscription.findOneAndUpdate({ _id: sub._id, active: true }, { $set: { active: false, disabledReason: `Switched off after ${DISABLE_AFTER_FAILURES} failed deliveries in a row (last: ${result.error || result.status}).` } });
    if (disabled) {
      await notificationService.notify(sub.organizationId, await managersOf(sub.organizationId), {
        title: 'A webhook was switched off', body: `${sub.url} failed ${DISABLE_AFTER_FAILURES} times in a row. Fix it and switch it on in Settings → API & webhooks.`, link: 'Settings.html?tab=integrations', source: 'webhooks',
      }).catch((error) => logger.error(`Webhook note failed: ${error.message}`));
    }
  }
  return retry ? 'retrying' : 'failed';
}

async function deliver({ deliveryId }, job, queue = require('../jobs/queue')) {
  const delivery = await WebhookDelivery.findById(deliveryId);
  if (!delivery || delivery.status !== 'pending') return;
  const sub = await WebhookSubscription.findById(delivery.subscriptionId);
  if (!sub || !sub.active) {
    await WebhookDelivery.updateOne({ _id: delivery._id }, { $set: { status: 'cancelled', error: sub ? 'The webhook is switched off.' : 'The webhook was removed.' } });
    return;
  }
  await recordResult(sub, delivery, await post(sub, delivery), queue);
}

// --- events → deliveries -------------------------------------------------------------------------
const POPULATE_CONTACT = { path: 'contactId', select: 'name phoneE164 email company' };
const byId = (Model, id, populate) => (id && mongoose.isValidObjectId(id) ? (populate ? Model.findById(id).populate(populate) : Model.findById(id)) : null);

// What each event carries (the public API's shapes).
async function dataOf(event) {
  const contact = async () => { const c = await byId(Contact, event.contactId); return c ? publicApi.publicContact(c) : null; };
  switch (event.type) {
    case 'lead.created':
    case 'lead.stage_changed': {
      const lead = await byId(Lead, event.leadId, POPULATE_CONTACT);
      return { lead: lead ? publicApi.publicLead(lead) : null, ...(event.type === 'lead.stage_changed' && { from: event.from, to: event.to }) };
    }
    case 'contact.created':
      return { contact: await contact() };
    case 'message.received': {
      const message = await byId(Message, event.messageId);
      return {
        message: message ? { id: String(message._id), type: message.type, text: message.text || '', at: message.providerTimestamp || message.createdAt } : null,
        conversationId: String(event.conversationId || ''), contact: await contact(),
      };
    }
    case 'quotation.status_changed': {
      const quotation = await byId(Quotation, event.quotationId);
      return { quotation: quotation ? publicApi.publicQuotation(quotation) : null, from: event.from, to: event.to };
    }
    case 'order.created':
    case 'order.stage_changed': {
      const order = await byId(Order, event.orderId);
      return { order: order ? publicApi.publicOrder(order) : null, ...(event.type === 'order.stage_changed' && { from: event.from, to: event.to }) };
    }
    case 'payment.received': {
      const order = await byId(Order, event.orderId);
      return { amountPaise: event.amountPaise || 0, orderId: event.orderId ? String(event.orderId) : null, leadId: event.leadId ? String(event.leadId) : null, order: order ? publicApi.publicOrder(order) : null, contact: await contact() };
    }
    default:
      return {};
  }
}

async function fanout({ event }, job, queue = require('../jobs/queue')) {
  const subs = await WebhookSubscription.find({ organizationId: event.organizationId, active: true, events: event.type });
  if (!subs.length) return;
  if (!planService.hasFeature(await Organization.findById(event.organizationId), 'api')) return;
  const eventId = eventIdOf(event.key);
  const payload = { id: eventId, type: event.type, createdAt: new Date(event.at || Date.now()).toISOString(), data: await dataOf(event) };
  for (const sub of subs) {
    let delivery;
    try {
      delivery = await WebhookDelivery.create({ organizationId: event.organizationId, subscriptionId: sub._id, eventId, event: event.type, payload });
    } catch (error) {
      if (error.code === 11000) continue; // a retried fan-out
      throw error;
    }
    await queue.enqueue(JOBS.DELIVER, { deliveryId: String(delivery._id) }, { uniqueKey: `webhook.deliver:${delivery._id}:0`, organizationId: event.organizationId, maxAttempts: 2 });
  }
}

// POST /outbound-webhooks/:id/test — a "ping" now, with the answer.
async function test(req, id) {
  const sub = await findInOrg(req, id);
  const eventId = `evt_test_${crypto.randomBytes(8).toString('hex')}`;
  const delivery = await WebhookDelivery.create({
    organizationId: sub.organizationId, subscriptionId: sub._id, eventId, event: 'ping',
    payload: { id: eventId, type: 'ping', createdAt: new Date().toISOString(), data: { message: 'A test from YELLOW CRM. Answer 2xx to confirm.' } },
  });
  const result = await post(sub, delivery);
  await recordResult(sub, delivery, result, null);
  return serializeDelivery(await WebhookDelivery.findById(delivery._id));
}

// POST /outbound-webhooks/deliveries/:id/retry — send a failed one again now.
async function retry(req, deliveryId, queue = require('../jobs/queue')) {
  const delivery = mongoose.isValidObjectId(deliveryId) ? await WebhookDelivery.findOne({ _id: deliveryId, organizationId: req.tenant.organizationId }) : null;
  if (!delivery) throw httpError(404, 'NOT_FOUND', 'Delivery not found');
  if (delivery.status === 'delivered') throw httpError(409, 'ALREADY_DELIVERED', 'This one was delivered.');
  await WebhookDelivery.updateOne({ _id: delivery._id }, { $set: { status: 'pending', attempts: 0, error: '' } });
  await queue.enqueue(JOBS.DELIVER, { deliveryId: String(delivery._id) }, { uniqueKey: `webhook.deliver:${delivery._id}:retry:${Date.now()}`, organizationId: delivery.organizationId, maxAttempts: 2 });
  return serializeDelivery(await WebhookDelivery.findById(delivery._id));
}

let listener = null;
function register(queue) {
  queue.define(JOBS.FANOUT, (data, job) => fanout(data, job, queue), { maxAttempts: 4 });
  queue.define(JOBS.DELIVER, (data, job) => deliver(data, job, queue), { maxAttempts: 2 });
  if (listener) bus.off('automation:event', listener);
  listener = (event) => {
    if (!WEBHOOK_EVENT_KEYS.includes(event.type)) return;
    WebhookSubscription.exists({ organizationId: event.organizationId, active: true, events: event.type })
      .then((any) => any && queue.enqueue(JOBS.FANOUT, { event }, { uniqueKey: `webhook.fanout:${event.key}`, organizationId: event.organizationId }))
      .catch((error) => logger.error(`Webhook event ${event.type} could not be queued: ${error.message}`));
  };
  bus.on('automation:event', listener);
}

const meta = () => ({ events: Object.entries(WEBHOOK_EVENTS).map(([event, label]) => ({ event, label })) });

module.exports = {
  JOBS, list, create, update, remove, rotateSecret, listDeliveries, test, retry, fanout, deliver, register, meta,
  serialize, serializeDelivery, eventIdOf, RETRY_AFTER_MS, DISABLE_AFTER_FAILURES,
};
