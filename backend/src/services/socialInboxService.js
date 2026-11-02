const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const InboundEvent = require('../models/InboundEvent');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Message = require('../models/Message');
const SocialAccount = require('../models/SocialAccount');
const env = require('../config/env');
const bus = require('../realtime/bus');
const automationEvents = require('./automation/events');
const media = require('./whatsappMediaService');
const { previewOf } = require('./whatsappInboundService');
const { credentials } = require('./socialAccountService');
const { providerFor } = require('../integrations/social');
const { STAGE_PROBABILITY } = require('../constants/crm');
const { SOCIAL_LEAD_SOURCE } = require('../constants/social');

// Instagram and Messenger messages into the team inbox (G8, D112). Meta's app-level webhook
// (/webhooks/meta, signed with the app secret) brings objects "page" (Messenger, entry.id = the
// Page) and "instagram" (entry.id = the Instagram account), each with a messaging[] list (Meta's
// docs read 2026-11-02). whatsappInboundService stores the items as InboundEvents (provider
// meta-social, the same processing and retries as WhatsApp's) and hands them back here:
//   message — a customer's message (or a tapped button): a new customer becomes a contact and a
//             lead (source Instagram or Messenger) with their own chat; files are copied into the
//             CRM. No bot, auto-reply or workflow answers on these channels: people do.
//   echo    — what the business sent: ours are known already; one sent from Meta's own apps
//             (Business Suite, Instagram) is added to the chat like a message from the phone.
//   read / delivery — our messages' ticks.
const PROVIDER = 'meta-social';
const TEXT_LIMIT = 8000;
const str = (value, max = 500) => (value == null ? '' : String(value).slice(0, max));
const timeOf = (ms) => {
  const date = new Date(Number(ms));
  return Number.isNaN(date.getTime()) || !Number(ms) ? new Date() : date;
};
const channelOf = (object) => (object === 'instagram' ? 'instagram' : 'messenger');
const NAME = { instagram: 'Instagram', messenger: 'Messenger' };

// --- the webhook --------------------------------------------------------------------------------
// The items of a page or instagram webhook for connected accounts → the new InboundEvent ids.
async function ingest(payload) {
  const channel = channelOf(payload?.object);
  const accounts = new Map();
  const items = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    const externalId = str(entry?.id, 100);
    if (!externalId) continue;
    if (!accounts.has(externalId)) accounts.set(externalId, await SocialAccount.findOne({ channel, activeExternalId: externalId }));
    const account = accounts.get(externalId);
    if (!account) continue;
    for (const event of Array.isArray(entry.messaging) ? entry.messaging : []) {
      const message = event?.message;
      let kind = '';
      let key = '';
      if (message?.mid && message.is_echo) [kind, key] = ['echo', message.mid];
      else if (message?.mid && !message.is_deleted) [kind, key] = ['message', message.mid];
      else if (event?.postback) [kind, key] = ['message', event.postback.mid || `postback:${event.sender?.id}:${event.timestamp}`];
      else if (event?.read) [kind, key] = ['read', `${event.sender?.id}:${event.read.watermark || event.read.mid}`];
      else if (event?.delivery) [kind, key] = ['delivery', `${event.sender?.id}:${event.delivery.watermark}`];
      if (!kind) continue; // reactions, referrals and the rest are not kept
      items.push({
        provider: PROVIDER, kind: `social_${kind}`, eventId: `${channel}:${kind}:${str(key, 300)}`,
        organizationId: account.organizationId, sourceId: account._id, payload: { channel, event },
      });
    }
  }
  const ids = [];
  for (const item of items) {
    try {
      ids.push((await InboundEvent.create(item))._id);
    } catch (error) {
      if (error.code !== 11000) throw error; // Meta's retry of a stored item
    }
  }
  const touched = [...accounts.values()].filter(Boolean).map((account) => account._id);
  if (touched.length) await SocialAccount.updateMany({ _id: { $in: touched } }, { $set: { lastWebhookAt: new Date() } });
  return ids;
}

// --- what a message holds ---------------------------------------------------------------------------
const MEDIA = { image: 'image', video: 'video', audio: 'audio', file: 'document' };
const SHARED = {
  share: 'Shared a post', ig_post: 'Shared a post', post: 'Shared a post', ig_reel: 'Shared a reel', reel: 'Shared a reel',
  story_mention: 'Mentioned you in their story', fallback: 'Shared a link', template: 'Shared a product',
};
function messageFields(event) {
  if (event.postback) {
    const title = str(event.postback.title, 200);
    return { type: 'button', text: title, reply: { id: str(event.postback.payload, 200), title } };
  }
  const message = event.message || {};
  const fields = { type: 'text', text: str(message.text, TEXT_LIMIT) };
  if (message.reply_to?.mid) fields.replyToProviderMessageId = str(message.reply_to.mid, 300);
  const attachments = Array.isArray(message.attachments) ? message.attachments.filter((a) => a && typeof a === 'object') : [];
  const links = [];
  for (const attachment of attachments) {
    const url = str(attachment.payload?.url, 2000);
    const type = MEDIA[attachment.type];
    if (type && url && !fields.media) {
      fields.type = type;
      fields.media = { url, ...(attachment.type === 'audio' && { voice: true }) };
    } else {
      links.push(`${SHARED[attachment.type] || 'Sent a file'}${url ? `: ${url}` : ''}`);
    }
  }
  if (message.reply_to?.story) links.unshift(`Replied to your story${message.reply_to.story.url ? `: ${str(message.reply_to.story.url, 2000)}` : ''}`);
  if (links.length) fields.text = [fields.text, ...links].filter(Boolean).join('\n').slice(0, TEXT_LIMIT);
  if (fields.type === 'text' && !fields.text) fields.type = 'unsupported';
  return fields;
}

// --- a customer's message -------------------------------------------------------------------------
async function newCustomer(account, channel, userId, at) {
  const { organizationId } = account;
  const profile = await providerFor(account).profile(credentials(account), { channel, userId }).catch(() => ({}));
  const username = str(profile.username, 100);
  const name = str(profile.name, 200).trim() || (username ? `@${username}` : `${NAME[channel]} user ${userId.slice(-4)}`);
  const source = SOCIAL_LEAD_SOURCE[channel];
  const contact = await Contact.create({ organizationId, name, source, lifecycle: 'lead' });
  let lead = null;
  try {
    lead = await Lead.create({
      organizationId, contactId: contact._id, stage: 'New', probability: STAGE_PROBABILITY.New, source, sourceRef: `${channel}:${userId}`,
      stageChangedAt: new Date(), lastActivityAt: new Date(),
    });
    await LeadActivity.create({ organizationId, leadId: lead._id, contactId: contact._id, type: 'Lead created', text: `First message on ${NAME[channel]}`, actorName: NAME[channel] });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  try {
    const conversation = await Conversation.create({
      organizationId, contactId: contact._id, whatsappAccountId: account._id, channel, socialAccountId: account._id, socialUserId: userId,
      ...(username && { socialUsername: username }), status: 'open', openedAt: at,
    });
    automationEvents.emit('contact.created', { organizationId, contactId: contact._id, source, key: `contact.created:${contact._id}` });
    return { conversation, contact, lead };
  } catch (error) {
    if (error.code !== 11000) throw error;
    // The same customer's other message made the chat at the same moment: theirs stays.
    await Promise.all([Contact.deleteOne({ _id: contact._id }), lead && Lead.deleteOne({ _id: lead._id }), lead && LeadActivity.deleteMany({ leadId: lead._id })]);
    const conversation = await Conversation.findOne({ organizationId, socialAccountId: account._id, socialUserId: userId });
    return { conversation, contact: await Contact.findById(conversation.contactId), lead: null };
  }
}

async function handleMessage(account, { channel, event }) {
  const userId = str(event.sender?.id, 100);
  if (!userId || userId === account.externalId || userId === account.pageId) return 'ignored';
  const { organizationId } = account;
  const at = timeOf(event.timestamp);
  const fields = messageFields(event);
  let conversation = await Conversation.findOne({ organizationId, socialAccountId: account._id, socialUserId: userId });
  let contact = conversation && await Contact.findOne({ _id: conversation.contactId, organizationId });
  let lead = null;
  let created = false;
  if (!conversation) {
    ({ conversation, contact, lead } = await newCustomer(account, channel, userId, at));
    created = Boolean(lead);
  } else if (!contact) {
    // The customer was deleted from the CRM: they come back as a new contact in the same chat.
    contact = await Contact.create({ organizationId, name: `${NAME[channel]} user ${userId.slice(-4)}`, source: SOCIAL_LEAD_SOURCE[channel], lifecycle: 'lead' });
    conversation = await Conversation.findOneAndUpdate({ _id: conversation._id }, { $set: { contactId: contact._id } }, { returnDocument: 'after' });
  }
  const blocked = Boolean(contact.blocked?.at);
  if (conversation.status === 'closed' && !blocked) await Conversation.updateOne({ _id: conversation._id, status: 'closed' }, { $set: { openedAt: at } });

  let stored;
  try {
    stored = await Message.create({
      organizationId, conversationId: conversation._id, contactId: contact._id, whatsappAccountId: account._id, channel,
      direction: 'in', status: 'received', providerMessageId: str(event.message?.mid || event.postback?.mid, 300) || undefined, providerTimestamp: at, ...fields,
    });
  } catch (error) {
    if (error.code === 11000) return 'ignored';
    throw error;
  }
  conversation = await Conversation.findOneAndUpdate(
    { _id: conversation._id },
    blocked
      ? { $max: { lastInboundAt: at, lastMessageAt: at } }
      : { $set: { status: 'open' }, $unset: { archivedAt: 1, archivedById: 1 }, $inc: { unreadCount: 1 }, $max: { lastInboundAt: at, lastMessageAt: at } },
    { returnDocument: 'after' },
  );
  if (conversation.lastMessageAt.getTime() === at.getTime()) {
    conversation = await Conversation.findOneAndUpdate(
      { _id: conversation._id },
      { $set: { lastMessagePreview: previewOf(fields), lastMessageDirection: 'in', lastMessageOrigin: '' } },
      { returnDocument: 'after' },
    );
  }
  bus.emit('message:new', { organizationId, conversation, message: stored, contactCreated: created });
  if (lead) {
    bus.emit('lead:intake', {
      organizationId, source: lead.source, sourceRef: lead.sourceRef, leadId: lead._id, contactId: contact._id, outcome: 'created', contactCreated: true, receivedAt: at,
    });
  }
  if (stored.media?.url) await media.storeInboundQuietly(stored);
  return 'processed';
}

// --- what the business sent ---------------------------------------------------------------------
// attempts: an echo of our own reply can come before the reply's id is saved, so an unknown echo
// waits for one retry before it is taken as sent from Meta's apps.
async function handleEcho(account, { channel, event }, attempts) {
  const mid = str(event.message?.mid, 300);
  if (!mid || await Message.exists({ providerMessageId: mid })) return 'ignored';
  if (env.meta.appId && String(event.message?.app_id || '') === String(env.meta.appId)) return 'ignored'; // sent by this CRM
  if (attempts < 2) throw new Error('This echo may be a reply of ours that is not saved yet');
  const { organizationId } = account;
  const conversation = await Conversation.findOne({ organizationId, socialAccountId: account._id, socialUserId: str(event.recipient?.id, 100) });
  if (!conversation) return 'ignored'; // a chat the CRM never had
  const at = timeOf(event.timestamp);
  const fields = messageFields(event);
  let stored;
  try {
    stored = await Message.create({
      organizationId, conversationId: conversation._id, contactId: conversation.contactId, whatsappAccountId: account._id, channel,
      direction: 'out', status: 'sent', origin: 'phone', providerMessageId: mid, providerTimestamp: at, sentAt: at, ...fields,
    });
  } catch (error) {
    if (error.code === 11000) return 'ignored';
    throw error;
  }
  let updated = await Conversation.findOneAndUpdate({ _id: conversation._id }, { $max: { lastMessageAt: at } }, { returnDocument: 'after' });
  if (updated.lastMessageAt.getTime() === at.getTime()) {
    updated = await Conversation.findOneAndUpdate({ _id: conversation._id }, { $set: { lastMessagePreview: previewOf(fields), lastMessageDirection: 'out', lastMessageOrigin: '' } }, { returnDocument: 'after' });
  }
  bus.emit('message:new', { organizationId, conversation: updated, message: stored });
  return 'processed';
}

// --- ticks: delivered (Messenger: up to a time) and read (Messenger: up to a time; Instagram: a message)
async function handleStatus(account, { event }, status) {
  const conversation = await Conversation.findOne({ organizationId: account.organizationId, socialAccountId: account._id, socialUserId: str(event.sender?.id, 100) });
  if (!conversation) return 'ignored';
  const mark = status === 'read' ? event.read : event.delivery;
  let until = mark?.watermark ? timeOf(mark.watermark) : null;
  if (!until && mark?.mid) until = (await Message.findOne({ conversationId: conversation._id, providerMessageId: str(mark.mid, 300) }).select('createdAt'))?.createdAt;
  if (!until) return 'ignored';
  const lower = status === 'read' ? ['sent', 'delivered'] : ['sent'];
  const filter = { conversationId: conversation._id, direction: 'out', status: { $in: lower }, createdAt: { $lte: until } };
  const changed = await Message.find(filter).sort({ createdAt: -1 }).limit(50);
  if (!changed.length) return 'processed';
  await Message.updateMany({ _id: { $in: changed.map((m) => m._id) } }, { $set: { status, [`${status}At`]: new Date() } });
  for (const message of await Message.find({ _id: { $in: changed.slice(0, 20).map((m) => m._id) } })) {
    bus.emit('message:status', { organizationId: account.organizationId, message });
  }
  return 'processed';
}

// One stored item (whatsappInboundService.processEvent claims it and keeps the outcome).
async function handleEvent(event) {
  const account = await SocialAccount.findOne({ _id: event.sourceId, organizationId: event.organizationId });
  if (!account) return 'ignored';
  const handlers = {
    social_message: () => handleMessage(account, event.payload),
    social_echo: () => handleEcho(account, event.payload, event.attempts),
    social_read: () => handleStatus(account, event.payload, 'read'),
    social_delivery: () => handleStatus(account, event.payload, 'delivered'),
  };
  return handlers[event.kind] ? handlers[event.kind]() : 'ignored';
}

module.exports = { PROVIDER, ingest, handleEvent, messageFields };
