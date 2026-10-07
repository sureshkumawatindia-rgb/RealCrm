const crypto = require('crypto');
const InboundEvent = require('../models/InboundEvent');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const logger = require('../config/logger');
const bus = require('../realtime/bus');
const automationEvents = require('./automation/events');
const { appSecretOf } = require('./whatsappAccountService');
const media = require('./whatsappMediaService');
const templateService = require('./templateService');
const { STAGE_PROBABILITY } = require('../constants/crm');
const { MESSAGE_TYPES, MEDIA_TYPES, STATUS_RANK } = require('../constants/whatsapp');

// Incoming WhatsApp webhooks (Cloud API "messages" field):
// https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages
// 1. The route checks X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret).
// 2. ingest() stores each message and status as an InboundEvent (unique id: Meta's retries are harmless).
// 3. After answering 200, processLater() turns them into contacts, leads, conversations and messages.
// Template status changes (field message_template_status_update) are stored and handled the same way.
const MAX_ATTEMPTS = 5;
const TEXT_LIMIT = 8000;

const str = (value, max = 500) => (value == null ? '' : String(value).slice(0, max));
const unixTime = (value) => {
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

// --- signature -------------------------------------------------------------
function signatureOk(account, rawBody, header) {
  const secret = appSecretOf(account);
  const match = /^sha256=([a-f0-9]{64})$/i.exec(String(header || ''));
  if (!secret || !match || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(match[1], 'hex'));
}

// --- storing the webhook ----------------------------------------------------
// Returns the ids of the events that are new (retries of stored events are skipped).
async function ingest(account, payload) {
  const items = [];
  // One Meta app (one callback URL) can serve several numbers of the same company: items of
  // another connected number of this organization go to that number; unknown numbers are skipped.
  const numbers = new Map([[account.phoneNumberId, account]]);
  const numberFor = async (phoneNumberId) => {
    if (!phoneNumberId) return account;
    const id = String(phoneNumberId);
    if (!numbers.has(id)) numbers.set(id, await WhatsAppAccount.findOne({ organizationId: account.organizationId, activePhoneNumberId: id }));
    return numbers.get(id);
  };
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value || {};
      if (change?.field === 'message_template_status_update') {
        if (!value.message_template_id || !value.event) continue;
        items.push({
          kind: 'template_status', sourceId: account._id,
          eventId: `template:${value.message_template_id}:${value.event}:${entry.time || ''}`, payload: { value },
        });
        continue;
      }
      if (change?.field !== 'messages') continue;
      const target = await numberFor(value.metadata?.phone_number_id);
      if (!target) continue;
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        if (!message?.id) continue;
        const contact = contacts.find((c) => c?.wa_id === message.from) || contacts[0] || null;
        items.push({ kind: 'message', sourceId: target._id, eventId: `message:${message.id}`, payload: { message, contact } });
      }
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        if (!status?.id || !status.status) continue;
        items.push({ kind: 'status', sourceId: target._id, eventId: `status:${status.id}:${status.status}`, payload: { status } });
      }
    }
  }

  const ids = [];
  for (const item of items) {
    try {
      const event = await InboundEvent.create({ provider: 'whatsapp', ...item, organizationId: account.organizationId });
      ids.push(event._id);
    } catch (error) {
      if (error.code !== 11000) throw error; // already received
    }
  }
  await WhatsAppAccount.updateOne({ _id: account._id }, { lastWebhookAt: new Date() });
  return ids;
}

// --- turning a message into CRM records -----------------------------------------
// The fields of our Message document for one webhook message object.
function messageFields(message) {
  const type = MESSAGE_TYPES.includes(message.type) && message.type !== 'template' ? message.type : 'unsupported';
  const fields = { type, text: '' };
  if (type === 'text') fields.text = str(message.text?.body, TEXT_LIMIT);
  if (MEDIA_TYPES.includes(type)) {
    const media = message[type] || {};
    fields.text = str(media.caption, TEXT_LIMIT);
    fields.media = {
      providerMediaId: str(media.id, 200), mimeType: str(media.mime_type, 100), sha256: str(media.sha256, 200),
      fileName: str(media.filename, 200), voice: media.voice === true ? true : undefined,
    };
  }
  if (type === 'location') {
    const place = message.location || {};
    fields.location = { latitude: Number(place.latitude), longitude: Number(place.longitude), name: str(place.name, 200), address: str(place.address, 500) };
  }
  if (type === 'interactive') {
    const choice = message.interactive?.button_reply || message.interactive?.list_reply || {};
    fields.reply = { id: str(choice.id, 200), title: str(choice.title, 200) };
    fields.text = fields.reply.title;
  }
  if (type === 'button') {
    fields.reply = { id: str(message.button?.payload, 200), title: str(message.button?.text, 200) };
    fields.text = fields.reply.title;
  }
  if (type === 'reaction') fields.reaction = { providerMessageId: str(message.reaction?.message_id, 200), emoji: str(message.reaction?.emoji, 20) };
  // A cart from the WhatsApp catalog (Phase 8C); the CRM turns it into an order.
  if (type === 'order') {
    const order = message.order || {};
    const items = (Array.isArray(order.product_items) ? order.product_items : []).slice(0, 100).map((item) => ({
      retailerId: str(item?.product_retailer_id, 100),
      quantity: Math.max(Math.floor(Number(item?.quantity) || 0), 0),
      itemPricePaise: Math.round((Number(item?.item_price) || 0) * 100),
      currency: str(item?.currency, 3),
    })).filter((item) => item.retailerId && item.quantity > 0);
    fields.order = { catalogId: str(order.catalog_id, 100), text: str(order.text, 1000), items };
    const count = items.reduce((sum, item) => sum + item.quantity, 0);
    fields.text = fields.order.text || `${count} ${count === 1 ? 'item' : 'items'} from the catalog`;
  }
  if (type === 'contacts') {
    fields.text = (Array.isArray(message.contacts) ? message.contacts : []).map((c) => str(c?.name?.formatted_name, 100)).filter(Boolean).join(', ');
  }
  if (message.context?.id) fields.replyToProviderMessageId = str(message.context.id, 200);
  return fields;
}

// The one-line summary shown in the conversation list.
function previewOf(fields) {
  const labels = {
    image: 'Photo', video: 'Video', audio: fields.media?.voice ? 'Voice message' : 'Audio', sticker: 'Sticker',
    document: `Document${fields.media?.fileName ? `: ${fields.media.fileName}` : ''}`, location: 'Location',
    contacts: 'Contact card', reaction: `Reacted ${fields.reaction?.emoji || ''}`.trim(), unsupported: 'Unsupported message', order: 'Order',
  };
  const text = fields.text ? fields.text.replace(/\s+/g, ' ').trim() : '';
  const label = labels[fields.type];
  return str(label && text ? `${label}: ${text}` : text || label || '', 200);
}

// wa_id is the number with its country code and no "+".
function phoneFromWaId(waId) {
  const digits = String(waId || '').replace(/\D/g, '');
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

async function findOrCreateContact(organizationId, phoneE164, name) {
  const existing = await Contact.findOne({ organizationId, phoneE164 });
  if (existing) return { contact: existing, created: false };
  try {
    const contact = await Contact.create({ organizationId, name, phone: phoneE164, phoneE164, source: 'WhatsApp', lifecycle: 'lead' });
    automationEvents.emit('contact.created', { organizationId, contactId: contact._id, source: 'WhatsApp', key: `contact.created:${contact._id}` });
    return { contact, created: true };
  } catch (error) {
    if (error.code !== 11000) throw error; // the same number arrived twice at once
    return { contact: await Contact.findOne({ organizationId, phoneE164 }), created: false };
  }
}

// A new number becomes a lead (source WhatsApp); sourceRef keeps it to one lead per number.
async function createLead(contact, phoneE164) {
  try {
    const lead = await Lead.create({
      organizationId: contact.organizationId, contactId: contact._id, stage: 'New', probability: STAGE_PROBABILITY.New,
      source: 'WhatsApp', sourceRef: `whatsapp:${phoneE164.slice(1)}`, stageChangedAt: new Date(), lastActivityAt: new Date(),
    });
    await LeadActivity.create({
      organizationId: contact.organizationId, leadId: lead._id, contactId: contact._id,
      type: 'Lead created', text: 'First message on WhatsApp', actorName: 'WhatsApp',
    });
    return lead;
  } catch (error) {
    if (error.code !== 11000) throw error;
    return null;
  }
}

async function handleMessage(account, { message, contact: profile }) {
  const phoneE164 = phoneFromWaId(message.from);
  if (!phoneE164) return 'ignored';
  const organizationId = account.organizationId;
  const at = unixTime(message.timestamp);
  const name = str(profile?.profile?.name, 200).trim() || phoneE164;

  const { contact, created } = await findOrCreateContact(organizationId, phoneE164, name);
  const newLead = created ? await createLead(contact, phoneE164) : null;

  let conversation = await Conversation.findOneAndUpdate(
    { organizationId, contactId: contact._id, whatsappAccountId: account._id },
    { $setOnInsert: { status: 'open' } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );

  const fields = messageFields(message);
  let stored;
  try {
    stored = await Message.create({
      organizationId, conversationId: conversation._id, contactId: contact._id, whatsappAccountId: account._id,
      direction: 'in', status: 'received', providerMessageId: str(message.id, 300), providerTimestamp: at, ...fields,
    });
  } catch (error) {
    if (error.code === 11000) return 'ignored'; // stored before (event log expired or replayed)
    throw error;
  }

  // Reopen the chat, count it unread and move the 24-hour window. Messages can arrive out of
  // order, so only the newest one sets the preview.
  conversation = await Conversation.findOneAndUpdate(
    { _id: conversation._id },
    { $set: { status: 'open' }, $inc: { unreadCount: 1 }, $max: { lastInboundAt: at, lastMessageAt: at } },
    { returnDocument: 'after' },
  );
  if (conversation.lastMessageAt.getTime() === at.getTime()) {
    conversation = await Conversation.findOneAndUpdate(
      { _id: conversation._id },
      { $set: { lastMessagePreview: previewOf(fields), lastMessageDirection: 'in' } },
      { returnDocument: 'after' },
    );
  }

  bus.emit('message:new', { organizationId, conversation, message: stored, contactCreated: created });
  automationEvents.emit('message.received', {
    organizationId, contactId: contact._id, conversationId: conversation._id, messageId: stored._id, text: stored.text || '', messageType: stored.type, replyId: stored.reply?.id || '', key: `message.received:${stored._id}`,
  });
  // A new WhatsApp lead goes through the assignment and auto-reply rules like any other source
  // (after its chat exists, so the chat is assigned together with the lead).
  if (newLead) {
    bus.emit('lead:intake', {
      organizationId, source: 'WhatsApp', sourceRef: newLead.sourceRef, leadId: newLead._id, contactId: contact._id, outcome: 'created', contactCreated: true, receivedAt: at,
    });
  }
  // Photos, voice notes and documents: copy the file now (WhatsApp keeps it only 7 days).
  if (stored.media?.providerMediaId) await media.storeInboundQuietly(stored);
  return 'processed';
}

// attempts: how often this event was tried. A status can arrive before our own send has saved
// Meta's message id, so an unknown message is retried a few times before it is ignored.
async function handleStatus(account, { status }, attempts) {
  if (!(status.status in STATUS_RANK) || status.status === 'received' || status.status === 'queued') return 'ignored';
  const message = await Message.findOne({ providerMessageId: str(status.id, 300), organizationId: account.organizationId });
  if (!message) {
    if (attempts < 3) throw new Error('The message of this status is not saved yet');
    return 'ignored';
  }
  const at = unixTime(status.timestamp);
  const set = { [`${status.status}At`]: at };
  if (status.status === 'failed') {
    const problem = Array.isArray(status.errors) ? status.errors[0] || {} : {};
    set.error = { code: Number(problem.code) || undefined, title: str(problem.title, 200), message: str(problem.error_data?.details || problem.message, 500) };
  }
  if (status.pricing) set.pricing = { billable: Boolean(status.pricing.billable), category: str(status.pricing.category, 50) };
  await Message.updateOne({ _id: message._id }, { $set: set });
  // Never move a message backwards (webhooks can arrive out of order).
  const lower = Object.keys(STATUS_RANK).filter((name) => STATUS_RANK[name] < STATUS_RANK[status.status]);
  const moved = await Message.findOneAndUpdate({ _id: message._id, status: { $in: lower } }, { $set: { status: status.status } }, { returnDocument: 'after' });
  if (moved) bus.emit('message:status', { organizationId: account.organizationId, message: moved });
  return 'processed';
}

// --- processing ----------------------------------------------------------------
async function processEvent(id) {
  const event = await InboundEvent.findOneAndUpdate(
    { _id: id, status: { $in: ['received', 'failed'] }, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  );
  if (!event) return;
  try {
    const account = await WhatsAppAccount.findOne({ _id: event.sourceId, organizationId: event.organizationId });
    const handlers = {
      message: () => handleMessage(account, event.payload),
      status: () => handleStatus(account, event.payload, event.attempts),
      template_status: () => templateService.applyStatusUpdate(account, event.payload.value || {}),
    };
    const outcome = !account || !handlers[event.kind] ? 'ignored' : await handlers[event.kind]();
    await InboundEvent.updateOne({ _id: event._id }, { status: outcome, processedAt: new Date(), error: '' });
  } catch (error) {
    logger.error(`WhatsApp event ${event.eventId} failed: ${error.message}`);
    await InboundEvent.updateOne({ _id: event._id }, { status: 'failed', error: str(error.message, 500) });
  }
}

// Events of one webhook are handled in order, after the HTTP answer.
const running = new Set();
async function processNow(ids) {
  for (const id of ids) await processEvent(id);
}
function processLater(ids) {
  const task = processNow(ids)
    .catch((error) => logger.error(`WhatsApp processing failed: ${error.message}`))
    .finally(() => running.delete(task));
  running.add(task);
}
// Resolves when every started batch is done (tests, graceful shutdown).
async function idle() {
  while (running.size) await Promise.all([...running]);
}

// Picks up events left behind by a restart or a failure (runs at start-up and every few minutes).
async function retryPending() {
  const stale = await InboundEvent.find({
    provider: 'whatsapp', status: { $in: ['received', 'failed'] }, attempts: { $lt: MAX_ATTEMPTS },
    updatedAt: { $lt: new Date(Date.now() - 60 * 1000) },
  }).sort({ createdAt: 1 }).limit(500).select('_id');
  await processNow(stale.map((event) => event._id));
  return stale.length;
}

function startRetryLoop(intervalMs = 5 * 60 * 1000) {
  const run = () => retryPending().catch((error) => logger.error(`WhatsApp retry failed: ${error.message}`));
  run();
  return setInterval(run, intervalMs).unref();
}

module.exports = {
  signatureOk, ingest, processNow, processLater, idle, retryPending, startRetryLoop, messageFields, previewOf, phoneFromWaId,
};
