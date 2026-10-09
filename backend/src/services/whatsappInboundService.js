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
const env = require('../config/env');
const { appSecretOf, serializeSync } = require('./whatsappAccountService');
const privateNumbers = require('./privateNumberService');
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
function signedWith(secret, rawBody, header) {
  const match = /^sha256=([a-f0-9]{64})$/i.exec(String(header || ''));
  if (!secret || !match || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(match[1], 'hex'));
}
// A number connected by hand: its own Meta app's secret.
const signatureOk = (account, rawBody, header) => signedWith(appSecretOf(account), rawBody, header);
// The platform's Meta app (D60): one secret for every "Connect WhatsApp" number.
const appSignatureOk = (rawBody, header) => signedWith(env.meta.appSecret, rawBody, header);

// --- storing the webhook ----------------------------------------------------
// The events of one change of a webhook for the number `target`.
// Fields: messages (messages and statuses), message_template_status_update, and for a WhatsApp
// Business app number (coexistence, D60): history (its chats of the last 6 months, in chunks),
// smb_message_echoes (what the business sent from the app on the phone), smb_app_state_sync
// (its contacts) and account_update (e.g. PARTNER_REMOVED: the business disconnected the CRM).
function itemsOf(target, entry, change) {
  const value = change?.value || {};
  const sourceId = target._id;
  const items = [];
  switch (change?.field) {
    case 'message_template_status_update':
      if (value.message_template_id && value.event) {
        items.push({ kind: 'template_status', sourceId, eventId: `template:${value.message_template_id}:${value.event}:${entry.time || ''}`, payload: { value } });
      }
      break;
    case 'messages': {
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        if (!message?.id) continue;
        const contact = contacts.find((c) => c?.wa_id === message.from) || contacts[0] || null;
        items.push({ kind: 'message', sourceId, eventId: `message:${message.id}`, payload: { message, contact } });
      }
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        if (!status?.id || !status.status) continue;
        items.push({ kind: 'status', sourceId, eventId: `status:${status.id}:${status.status}`, payload: { status } });
      }
      break;
    }
    case 'history':
      (Array.isArray(value.history) ? value.history : []).forEach((chunk, index) => {
        const meta = chunk?.metadata || {};
        const errorCode = chunk?.errors?.[0]?.code;
        const eventId = errorCode
          ? `history-error:${target.phoneNumberId}:${errorCode}:${entry.time || ''}`
          : `history:${target.phoneNumberId}:${meta.phase ?? ''}:${meta.chunk_order ?? index}:${meta.progress ?? ''}`;
        items.push({ kind: 'history', sourceId, eventId, payload: { chunk, businessPhone: str(value.metadata?.display_phone_number, 40) } });
      });
      break;
    case 'smb_message_echoes':
      for (const message of Array.isArray(value.message_echoes) ? value.message_echoes : []) {
        if (message?.id) items.push({ kind: 'echo', sourceId, eventId: `echo:${message.id}`, payload: { message } });
      }
      break;
    case 'smb_app_state_sync':
      for (const item of Array.isArray(value.state_sync) ? value.state_sync : []) {
        if (item?.type !== 'contact' || !item.contact?.phone_number) continue;
        items.push({
          kind: 'contact_sync', sourceId,
          eventId: `contact:${target.phoneNumberId}:${str(item.contact.phone_number, 30)}:${item.action}:${item.metadata?.timestamp || ''}`, payload: { item },
        });
      }
      break;
    case 'account_update':
      if (value.event) items.push({ kind: 'account_update', sourceId, eventId: `account:${entry.id}:${value.event}:${entry.time || ''}`, payload: { value } });
      break;
    default:
  }
  return items;
}

// Stores the items once each (Meta's retries of stored events are skipped) → the new ids.
async function store(items) {
  const ids = [];
  for (const item of items) {
    try {
      const event = await InboundEvent.create({ provider: 'whatsapp', ...item });
      ids.push(event._id);
    } catch (error) {
      if (error.code !== 11000) throw error; // already received
    }
  }
  return ids;
}

// The webhook of a number connected by hand (/webhooks/whatsapp/:webhookKey). One Meta app (one
// callback URL) can serve several numbers of the same company: items of another connected number
// of this organization go to that number; unknown numbers are skipped.
async function ingest(account, payload) {
  const items = [];
  const numbers = new Map([[account.phoneNumberId, account]]);
  const numberFor = async (phoneNumberId) => {
    if (!phoneNumberId) return account;
    const id = String(phoneNumberId);
    if (!numbers.has(id)) numbers.set(id, await WhatsAppAccount.findOne({ organizationId: account.organizationId, activePhoneNumberId: id }));
    return numbers.get(id);
  };
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const target = change?.field === 'message_template_status_update' ? account : await numberFor(change?.value?.metadata?.phone_number_id);
      if (target) items.push(...itemsOf(target, entry, change).map((item) => ({ ...item, organizationId: account.organizationId })));
    }
  }
  const ids = await store(items);
  await WhatsAppAccount.updateOne({ _id: account._id }, { lastWebhookAt: new Date() });
  return ids;
}

// The platform's app-level webhook (/webhooks/meta, D60): every number connected with "Connect
// WhatsApp", of every company. Each change goes to the number named in it (phone_number_id), or —
// for WABA-wide changes such as account_update — to the active number of that WABA (entry.id).
async function ingestApp(payload) {
  const items = [];
  const touched = new Set();
  const cache = new Map();
  const find = async (key, filter) => {
    if (!cache.has(key)) cache.set(key, await WhatsAppAccount.findOne(filter));
    return cache.get(key);
  };
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const phoneNumberId = change?.value?.metadata?.phone_number_id;
      const target = phoneNumberId
        ? await find(`p:${phoneNumberId}`, { activePhoneNumberId: String(phoneNumberId) })
        : entry?.id && await find(`w:${entry.id}`, { wabaId: String(entry.id), activePhoneNumberId: { $exists: true } });
      if (!target) continue;
      touched.add(String(target._id));
      items.push(...itemsOf(target, entry, change).map((item) => ({ ...item, organizationId: target.organizationId })));
    }
  }
  const ids = await store(items);
  if (touched.size) await WhatsAppAccount.updateMany({ _id: { $in: [...touched] } }, { lastWebhookAt: new Date() });
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

// quiet: imported from a WhatsApp Business app number (history, contacts, its own messages), or a
// private number — no automation hears about it (D60, D61). private: the number is private (D61).
async function findOrCreateContact(organizationId, phoneE164, name, { quiet = false, private: hidden = false } = {}) {
  const existing = await Contact.findOne({ organizationId, phoneE164 });
  if (existing) return { contact: existing, created: false };
  try {
    const contact = await Contact.create({ organizationId, name, phone: phoneE164, phoneE164, source: 'WhatsApp', lifecycle: 'lead', ...(hidden && { private: true }) });
    if (!quiet) automationEvents.emit('contact.created', { organizationId, contactId: contact._id, source: 'WhatsApp', key: `contact.created:${contact._id}` });
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

  // A private number (D61): stored for the owners only, with no lead, automation or notification.
  const privateNumber = await privateNumbers.isPrivate(organizationId, phoneE164);
  const { contact, created } = await findOrCreateContact(organizationId, phoneE164, name, { quiet: privateNumber, private: privateNumber });
  const hidden = privateNumber || Boolean(contact.private);
  const newLead = created && !hidden ? await createLead(contact, phoneE164) : null;

  let conversation = await Conversation.findOneAndUpdate(
    { organizationId, contactId: contact._id, whatsappAccountId: account._id },
    { $setOnInsert: { status: 'open', openedAt: at, ...(hidden && { private: true }) } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  // A closed chat the customer writes in again starts a new round (resolution time, D61).
  if (conversation.status === 'closed') await Conversation.updateOne({ _id: conversation._id, status: 'closed' }, { $set: { openedAt: at } });

  const fields = messageFields(message);
  let stored;
  try {
    stored = await Message.create({
      organizationId, conversationId: conversation._id, contactId: contact._id, whatsappAccountId: account._id,
      direction: 'in', status: 'received', providerMessageId: str(message.id, 300), providerTimestamp: at, ...(hidden && { private: true }), ...fields,
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
      { $set: { lastMessagePreview: previewOf(fields), lastMessageDirection: 'in', lastMessageOrigin: '' } },
      { returnDocument: 'after' },
    );
  }

  bus.emit('message:new', { organizationId, conversation, message: stored, contactCreated: created && !hidden });
  if (!hidden) {
    automationEvents.emit('message.received', {
      organizationId, contactId: contact._id, conversationId: conversation._id, messageId: stored._id, text: stored.text || '', messageType: stored.type, replyId: stored.reply?.id || '', key: `message.received:${stored._id}`,
    });
  }
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

// --- a WhatsApp Business app number (coexistence, D60) ---------------------------------------------
// None of this runs automations, the bot, auto-replies, lead creation or notifications: the
// history is the past, and echoes and contacts are the business's own doings on the phone.
const HISTORY_STATUS = { READ: 'read', PLAYED: 'read', DELIVERED: 'delivered', SENT: 'sent', PENDING: 'sent', ERROR: 'failed', FAILED: 'failed' };
const digitsOf = (value) => String(value || '').replace(/\D/g, '');
const RECENT_CHAT_MS = 7 * 24 * 60 * 60 * 1000;

async function chatOf(account, phoneE164, name) {
  const privateNumber = await privateNumbers.isPrivate(account.organizationId, phoneE164);
  const { contact, created } = await findOrCreateContact(account.organizationId, phoneE164, name, { quiet: true, private: privateNumber });
  const hidden = privateNumber || Boolean(contact.private);
  const before = await Conversation.findOne({ organizationId: account.organizationId, contactId: contact._id, whatsappAccountId: account._id }).select('_id');
  // An imported chat starts closed (it needs no answer); the customer's next message opens it.
  const conversation = before || await Conversation.findOneAndUpdate(
    { organizationId: account.organizationId, contactId: contact._id, whatsappAccountId: account._id },
    { $setOnInsert: { status: 'closed', ...(hidden && { private: true }) } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  return { contact, conversation, contactCreated: created, chatCreated: !before, hidden };
}

// Moves the chat's last-message time forward, and sets the preview when this is the newest.
// origin 'history': an imported message (time-based automations skip such chats).
async function touchChat(conversationId, { at, fields, direction, origin = '' }) {
  const set = { $max: { lastMessageAt: at, ...(direction === 'in' && { lastInboundAt: at }) } };
  let conversation = await Conversation.findOneAndUpdate({ _id: conversationId }, set, { returnDocument: 'after' });
  if (conversation.lastMessageAt.getTime() === at.getTime()) {
    conversation = await Conversation.findOneAndUpdate(
      { _id: conversationId },
      { $set: { lastMessagePreview: previewOf(fields), lastMessageDirection: direction, lastMessageOrigin: origin === 'history' ? 'history' : '' } },
      { returnDocument: 'after' },
    );
  }
  return conversation;
}

function announceSync(account) {
  bus.emit('whatsapp:sync', { organizationId: account.organizationId, accountId: account._id, sync: serializeSync(account) });
}

// One chunk of the history: threads (one per customer) of messages, with their real time.
async function handleHistory(account, { chunk, businessPhone }) {
  const error = chunk?.errors?.[0];
  if (error) {
    // 2593109: the business turned history sharing off in the WhatsApp Business app.
    const declined = Number(error.code) === 2593109;
    const updated = await WhatsAppAccount.findOneAndUpdate({ _id: account._id }, {
      $set: { 'sync.status': declined ? 'declined' : 'failed', 'sync.error': str(error.error_data?.details || error.message || error.title, 300), 'sync.finishedAt': new Date() },
    }, { returnDocument: 'after' });
    announceSync(updated);
    return 'processed';
  }
  const business = digitsOf(businessPhone || account.displayPhone);
  let messages = 0;
  let chats = 0;
  for (const thread of Array.isArray(chunk?.threads) ? chunk.threads : []) {
    const phoneE164 = phoneFromWaId(thread?.id);
    if (!phoneE164) continue;
    const { contact, conversation, chatCreated, hidden } = await chatOf(account, phoneE164, phoneE164);
    if (chatCreated) chats += 1;
    const docs = (Array.isArray(thread.messages) ? thread.messages : []).filter((message) => message?.id).map((message) => {
      const fields = messageFields(message);
      const direction = digitsOf(message.from) === digitsOf(thread.id) || (business && digitsOf(message.from) !== business) ? 'in' : 'out';
      const at = unixTime(message.timestamp);
      return {
        organizationId: account.organizationId, conversationId: conversation._id, contactId: contact._id, whatsappAccountId: account._id,
        direction, status: direction === 'in' ? 'received' : HISTORY_STATUS[String(message.history_context?.status || '').toUpperCase()] || 'sent',
        providerMessageId: str(message.id, 300), providerTimestamp: at, origin: 'history', ...(hidden && { private: true }), createdAt: at, updatedAt: new Date(), ...fields,
      };
    });
    if (!docs.length) continue;
    try {
      messages += (await Message.insertMany(docs, { ordered: false, timestamps: false })).length;
    } catch (bulk) {
      // Some were stored before (a retried webhook): keep the rest.
      if (!bulk.writeErrors?.every?.((item) => (item.err?.code ?? item.code) === 11000)) throw bulk;
      messages += bulk.insertedDocs?.length || 0;
    }
    const newest = docs.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    await touchChat(conversation._id, { at: newest.createdAt, fields: newest, direction: newest.direction, origin: 'history' });
    // A chat of the last week shows in the Inbox right away; older ones are under "Closed".
    if (chatCreated && newest.createdAt > new Date(Date.now() - RECENT_CHAT_MS)) await Conversation.updateOne({ _id: conversation._id }, { $set: { status: 'open' } });
    const newestIn = docs.filter((doc) => doc.direction === 'in').reduce((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);
    if (newestIn) await Conversation.updateOne({ _id: conversation._id }, { $max: { lastInboundAt: newestIn.createdAt } });
  }
  const meta = chunk?.metadata || {};
  const progress = Number(meta.progress);
  const phase = Number(meta.phase);
  // Chunks can arrive out of order: the progress only moves forward, and "done" stays done.
  const before = (await WhatsAppAccount.findById(account._id).select('sync')).sync || {};
  const ahead = Number.isFinite(phase) && Number.isFinite(progress)
    && (phase * 1000 + progress) >= ((Number(before.phase) || 0) * 1000 + (Number(before.progress) || 0));
  const done = before.status === 'done' || (ahead && phase >= 2 && progress >= 100);
  const updated = await WhatsAppAccount.findOneAndUpdate({ _id: account._id }, {
    $inc: { 'sync.messages': messages, 'sync.chats': chats },
    $set: {
      'sync.status': done ? 'done' : 'importing', ...(ahead && { 'sync.phase': phase, 'sync.progress': progress }),
      ...(done && before.status !== 'done' && { 'sync.finishedAt': new Date() }),
    },
  }, { returnDocument: 'after' });
  announceSync(updated);
  return 'processed';
}

// What the business sent from the WhatsApp Business app on the phone: shown in the chat as
// "sent from phone", live.
async function handleEcho(account, { message }) {
  const phoneE164 = phoneFromWaId(message.to);
  if (!phoneE164) return 'ignored';
  const { contact, conversation, hidden } = await chatOf(account, phoneE164, phoneE164);
  const fields = messageFields(message);
  const at = unixTime(message.timestamp);
  let stored;
  try {
    stored = await Message.create({
      organizationId: account.organizationId, conversationId: conversation._id, contactId: contact._id, whatsappAccountId: account._id,
      direction: 'out', status: 'sent', providerMessageId: str(message.id, 300), providerTimestamp: at, sentAt: at, origin: 'phone', ...(hidden && { private: true }), ...fields,
    });
  } catch (error) {
    if (error.code === 11000) return 'ignored';
    throw error;
  }
  const updated = await touchChat(conversation._id, { at, fields, direction: 'out' });
  bus.emit('message:new', { organizationId: account.organizationId, conversation: updated, message: stored });
  return 'processed';
}

// The WhatsApp Business app's contacts: names for the numbers (a removed contact stays in the CRM).
async function handleContactSync(account, { item }) {
  const phoneE164 = phoneFromWaId(item.contact?.phone_number);
  if (!phoneE164 || item.action === 'remove') return 'ignored';
  const name = str(item.contact.full_name || item.contact.first_name, 200).trim() || phoneE164;
  const privateNumber = await privateNumbers.isPrivate(account.organizationId, phoneE164);
  const { contact, created } = await findOrCreateContact(account.organizationId, phoneE164, name, { quiet: true, private: privateNumber });
  // A chat imported before its contact got the number as its name; the real name replaces it.
  if (!created && contact.name === phoneE164 && name !== phoneE164) await Contact.updateOne({ _id: contact._id }, { $set: { name } });
  if (created) await WhatsAppAccount.updateOne({ _id: account._id }, { $inc: { 'sync.contacts': 1 } });
  return 'processed';
}

// The business removed the CRM in WhatsApp (or Meta offboarded the number).
async function handleAccountUpdate(account, { value }) {
  if (!['PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED'].includes(String(value.event || '').toUpperCase())) return 'ignored';
  const reason = str(value.disconnection_info?.reason, 200);
  await WhatsAppAccount.updateOne({ _id: account._id }, {
    $set: { status: 'disconnected', statusMessage: `Disconnected in WhatsApp${reason ? ` (${reason})` : ''}. Connect it again from Settings → WhatsApp.` },
    $unset: { activePhoneNumberId: 1 },
  });
  logger.warn(`WhatsApp number ${account.phoneNumberId} was disconnected by the business (${value.event}).`);
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
      history: () => handleHistory(account, event.payload),
      echo: () => handleEcho(account, event.payload),
      contact_sync: () => handleContactSync(account, event.payload),
      account_update: () => handleAccountUpdate(account, event.payload),
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
  signatureOk, appSignatureOk, ingest, ingestApp, processNow, processLater, idle, retryPending, startRetryLoop, messageFields, previewOf, phoneFromWaId,
};
