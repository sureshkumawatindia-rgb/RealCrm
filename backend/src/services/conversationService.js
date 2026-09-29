const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Contact = require('../models/Contact');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const OrganizationMember = require('../models/OrganizationMember');
const httpError = require('../utils/httpError');
const logger = require('../config/logger');
const bus = require('../realtime/bus');
const { audit } = require('../utils/audit');
const { toPage, paginationMeta } = require('../utils/pagination');
const { isManager, canViewAll } = require('../constants/permissions');
const { SERVICE_WINDOW_MS } = require('../constants/whatsapp');
const { providerFor } = require('../integrations/whatsapp');
const { credentials } = require('./whatsappAccountService');
const noteService = require('./noteService');
const templateService = require('./templateService');
const mediaService = require('./whatsappMediaService');
const { previewOf } = require('./whatsappInboundService');
const { visibilityFilter } = require('./access');
const { documentStorage } = require('../storage');

// The shared WhatsApp inbox. Who sees which chat (D24): owners, admins and members with
// inbox:view_all see every chat; other inbox members see chats assigned to them and chats
// nobody has taken yet, so anyone can pick up a new customer.
const MESSAGE_PAGE = 50;

const seesAll = (member) => isManager(member) || canViewAll(member, 'inbox');
const scopeFilter = (req) => (seesAll(req.member) ? {} : { $or: [{ assigneeId: req.member._id }, { assigneeId: null }] });

// Free-form messages are only allowed within 24 hours of the customer's last message.
function serviceWindow(conversation, now = Date.now()) {
  const last = conversation.lastInboundAt ? conversation.lastInboundAt.getTime() : 0;
  const expiresAt = last ? new Date(last + SERVICE_WINDOW_MS) : null;
  return { open: Boolean(expiresAt && expiresAt.getTime() > now), expiresAt };
}

function serializeConversation(conversation) {
  const contact = conversation.contactId && typeof conversation.contactId === 'object' && conversation.contactId.name !== undefined ? conversation.contactId : null;
  const account = conversation.whatsappAccountId && typeof conversation.whatsappAccountId === 'object' && conversation.whatsappAccountId.phoneNumberId ? conversation.whatsappAccountId : null;
  return {
    id: conversation._id,
    contact: contact
      ? { id: contact._id, name: contact.name, phone: contact.phoneE164 || contact.phone || '', company: contact.company || '' }
      : { id: conversation.contactId, name: '', phone: '', company: '' },
    account: account
      ? { id: account._id, name: account.name, displayPhone: account.displayPhone, verifiedName: account.verifiedName }
      : { id: conversation.whatsappAccountId },
    assigneeId: conversation.assigneeId || null,
    status: conversation.status,
    unreadCount: conversation.unreadCount,
    lastMessageAt: conversation.lastMessageAt || null,
    lastMessagePreview: conversation.lastMessagePreview,
    lastMessageDirection: conversation.lastMessageDirection,
    lastInboundAt: conversation.lastInboundAt || null,
    window: serviceWindow(conversation),
    tags: conversation.tags,
    createdAt: conversation.createdAt,
  };
}

function serializeMessage(message) {
  return {
    id: message._id,
    conversationId: message.conversationId,
    direction: message.direction,
    type: message.type,
    text: message.text,
    media: message.media?.providerMediaId || message.media?.storageKey
      ? { mimeType: message.media.mimeType || '', fileName: message.media.fileName || '', sizeBytes: message.media.sizeBytes || null, voice: Boolean(message.media.voice), hasFile: Boolean(message.media.storageKey) }
      : null,
    location: message.location?.latitude != null ? message.location : null,
    reply: message.reply?.title ? message.reply : null,
    reaction: message.reaction?.emoji ? message.reaction : null,
    template: message.template?.name ? message.template : null,
    // Meta's message id (wamid): lets the page show which message a reply quotes.
    providerMessageId: message.providerMessageId || null,
    replyToProviderMessageId: message.replyToProviderMessageId || null,
    status: message.status,
    sentAt: message.sentAt || null,
    deliveredAt: message.deliveredAt || null,
    readAt: message.readAt || null,
    failedAt: message.failedAt || null,
    error: message.error?.message || message.error?.title ? message.error : null,
    sentByMemberId: message.sentByMemberId || null,
    at: message.providerTimestamp || message.createdAt,
    createdAt: message.createdAt,
  };
}

const POPULATE = [
  { path: 'contactId', select: 'name phone phoneE164 company' },
  { path: 'whatsappAccountId', select: 'name displayPhone verifiedName phoneNumberId' },
];

async function findVisible(req, id) {
  const conversation = await Conversation.findOne({ _id: id, organizationId: req.tenant.organizationId, ...scopeFilter(req) });
  if (!conversation) throw httpError(404, 'NOT_FOUND', 'Conversation not found');
  return conversation;
}

async function loadSerialized(id) {
  return serializeConversation(await Conversation.findById(id).populate(POPULATE));
}

// Everyone who should hear about a conversation right away (see realtime/socket.js).
function announce(event, conversation, extra = {}) {
  bus.emit(event, { organizationId: conversation.organizationId, conversation, ...extra });
}

// view: mine | unassigned | all; status: open | pending | closed | any (default open + pending);
// contactId: one customer's chats (Customer 360; q is ignored then).
async function list(req, query) {
  const filter = { organizationId: req.tenant.organizationId };
  if (query.view === 'mine') filter.assigneeId = req.member._id;
  if (query.view === 'unassigned') filter.assigneeId = null;
  if (query.status && query.status !== 'any') filter.status = query.status;
  if (!query.status) filter.status = { $in: ['open', 'pending'] };
  if (query.accountId) filter.whatsappAccountId = query.accountId;
  if (query.contactId) filter.contactId = query.contactId;
  if (query.q && !query.contactId) {
    const pattern = new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const digits = query.q.replace(/\D/g, '');
    const contacts = await Contact.find({
      organizationId: req.tenant.organizationId,
      $or: [{ name: pattern }, { company: pattern }, ...(digits.length >= 3 ? [{ phoneE164: new RegExp(digits) }] : [])],
    }).select('_id').limit(500);
    filter.contactId = { $in: contacts.map((contact) => contact._id) };
  }
  const scope = scopeFilter(req);
  const where = Object.keys(scope).length ? { $and: [filter, scope] } : filter;
  const page = toPage(query);
  const [items, total] = await Promise.all([
    Conversation.find(where).sort({ lastMessageAt: -1, _id: -1 }).skip(page.skip).limit(page.limit).populate(POPULATE),
    Conversation.countDocuments(where),
  ]);
  return { items: items.map(serializeConversation), pagination: paginationMeta(page, total) };
}

// Counts for the inbox tabs (open and pending chats) and the unread badge.
async function summary(req) {
  const base = { organizationId: req.tenant.organizationId, status: { $in: ['open', 'pending'] } };
  const scope = scopeFilter(req);
  const visible = Object.keys(scope).length ? { $and: [base, scope] } : base;
  const [mine, unassigned, all, unread] = await Promise.all([
    Conversation.countDocuments({ ...base, assigneeId: req.member._id }),
    Conversation.countDocuments({ ...base, assigneeId: null }),
    Conversation.countDocuments(visible),
    Conversation.aggregate([{ $match: { ...visible, unreadCount: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$unreadCount' } } }]),
  ]);
  return { mine, unassigned, all, unread: unread[0]?.total || 0 };
}

async function get(req, id) {
  const conversation = await findVisible(req, id);
  return loadSerialized(conversation._id);
}

// Status, assignee (null = nobody) and tags. The assignee must be an active member who can
// open the inbox.
async function update(req, id, body) {
  const conversation = await findVisible(req, id);
  const previousAssigneeId = conversation.assigneeId || null;
  if ('assigneeId' in body) {
    if (body.assigneeId) {
      const member = await OrganizationMember.findOne({ _id: body.assigneeId, organizationId: req.tenant.organizationId, status: 'active' });
      if (!member) throw httpError(400, 'VALIDATION_ERROR', 'Pick an active team member.', [{ field: 'assigneeId', code: 'INVALID_ASSIGNEE', message: 'Pick an active team member.' }]);
      if (!isManager(member) && !member.modules.includes('inbox')) {
        throw httpError(400, 'VALIDATION_ERROR', 'This teammate cannot open the Inbox.', [{ field: 'assigneeId', code: 'ASSIGNEE_NO_INBOX', message: 'Give them the Inbox page first.' }]);
      }
      conversation.assigneeId = member._id;
    } else {
      conversation.assigneeId = null;
    }
  }
  if ('status' in body) conversation.status = body.status;
  if ('tags' in body) conversation.tags = [...new Set(body.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
  await conversation.save();
  await audit(req, { action: 'conversation.updated', entityType: 'Conversation', entityId: conversation._id, changes: Object.keys(body) });
  announce('conversation:updated', conversation, { previousAssigneeId });
  return loadSerialized(conversation._id);
}

async function markRead(req, id) {
  const conversation = await findVisible(req, id);
  if (conversation.unreadCount) {
    conversation.unreadCount = 0;
    await conversation.save();
    announce('conversation:updated', conversation);
  }
  return loadSerialized(conversation._id);
}

// Newest page first; pass before=<message id> for older ones. Items come back oldest → newest.
async function listMessages(req, id, { before, limit = MESSAGE_PAGE } = {}) {
  const conversation = await findVisible(req, id);
  const filter = { organizationId: req.tenant.organizationId, conversationId: conversation._id };
  if (before) {
    const anchor = await Message.findOne({ _id: before, conversationId: conversation._id }).select('createdAt');
    if (anchor) filter.$or = [{ createdAt: { $lt: anchor.createdAt } }, { createdAt: anchor.createdAt, _id: { $lt: anchor._id } }];
  }
  const size = Math.min(Math.max(Number(limit) || MESSAGE_PAGE, 1), 100);
  const page = await Message.find(filter).sort({ createdAt: -1, _id: -1 }).limit(size + 1);
  const hasMore = page.length > size;
  const items = page.slice(0, size).reverse();
  return { items: items.map(serializeMessage), hasMore, nextBefore: hasMore ? items[0]._id : null };
}

// --- sending ---------------------------------------------------------------------
// The chat, its number and the customer's phone. Free-form messages (text, files) need the
// 24-hour window; approved templates do not.
async function sendContext(req, id, { needsWindow }) {
  const conversation = await findVisible(req, id);
  if (needsWindow && !serviceWindow(conversation).open) {
    throw httpError(422, 'WINDOW_CLOSED', 'The customer has not written in the last 24 hours. WhatsApp only allows an approved template now.');
  }
  const [account, contact] = await Promise.all([
    WhatsAppAccount.findOne({ _id: conversation.whatsappAccountId, organizationId: conversation.organizationId }),
    Contact.findOne({ _id: conversation.contactId, organizationId: conversation.organizationId }),
  ]);
  if (!account) throw httpError(409, 'NUMBER_REMOVED', 'This chat\'s WhatsApp number was removed from Settings.');
  if (!contact?.phoneE164) throw httpError(409, 'NO_PHONE', 'This contact has no WhatsApp number.');
  return { conversation, account, contact };
}

async function replyTarget(conversation, replyToMessageId) {
  if (!replyToMessageId) return null;
  const message = await Message.findOne({ _id: replyToMessageId, conversationId: conversation._id }).select('providerMessageId');
  return message?.providerMessageId || null;
}
const quoting = (providerMessageId) => (providerMessageId ? { context: { message_id: providerMessageId } } : {});

// The message is saved first (queued), then handed to WhatsApp: accepted → sent, refused →
// failed with WhatsApp's reason (the message stays in the chat either way). buildBody(message)
// returns the Cloud API message object (it may upload a file first).
async function deliver(req, { conversation, account, contact }, fields, buildBody) {
  const message = await Message.create({
    organizationId: conversation.organizationId, conversationId: conversation._id, contactId: contact._id,
    whatsappAccountId: account._id, direction: 'out', status: 'queued', sentByMemberId: req.member._id, ...fields,
  });
  try {
    const body = await buildBody(message);
    const { providerMessageId } = await providerFor(account).sendMessage(credentials(account), { to: contact.phoneE164.slice(1), ...body });
    message.providerMessageId = providerMessageId || undefined;
    message.status = 'sent';
    message.sentAt = new Date();
  } catch (error) {
    logger.warn(`WhatsApp send failed for conversation ${conversation._id}: ${error.message}`);
    message.status = 'failed';
    message.failedAt = new Date();
    message.error = { code: Number(error.providerCode) || undefined, message: String(error.message || 'Sending failed').slice(0, 500) };
  }
  await message.save();

  // The first reply takes an unassigned chat; a reply reopens a closed one.
  const set = { lastMessageAt: message.createdAt, lastMessagePreview: previewOf(fields), lastMessageDirection: 'out', status: 'open' };
  if (!conversation.assigneeId) set.assigneeId = req.member._id;
  const updated = await Conversation.findOneAndUpdate({ _id: conversation._id }, { $set: set }, { returnDocument: 'after' });
  bus.emit('message:new', { organizationId: conversation.organizationId, conversation: updated, message });
  if (!conversation.assigneeId) announce('conversation:updated', updated, { previousAssigneeId: null });
  return serializeMessage(message);
}

async function sendText(req, id, { text, replyToMessageId }) {
  const context = await sendContext(req, id, { needsWindow: true });
  const replyTo = await replyTarget(context.conversation, replyToMessageId);
  return deliver(req, context, { type: 'text', text, replyToProviderMessageId: replyTo || undefined }, async () => ({
    type: 'text',
    text: { body: text, preview_url: /https?:\/\//i.test(text) },
    ...quoting(replyTo),
  }));
}

// An approved template of the chat's number, with its variables filled in.
async function sendTemplate(req, id, { templateId, variables }) {
  const context = await sendContext(req, id, { needsWindow: false });
  const template = await templateService.findSendable(req.tenant.organizationId, templateId);
  if (String(template.whatsappAccountId) !== String(context.account._id)) {
    throw httpError(400, 'VALIDATION_ERROR', 'This template belongs to another WhatsApp number.', [{ field: 'templateId', code: 'OTHER_NUMBER', message: 'Pick a template of this chat\'s number.' }]);
  }
  const { payload, text, values } = templateService.buildSend(template, variables);
  return deliver(req, context, { type: 'template', text, template: { name: template.name, language: template.language, variables: values } }, async () => ({
    type: 'template',
    template: payload,
  }));
}

// A photo, video, audio file or document. A copy stays in the CRM's storage.
async function sendMedia(req, id, { caption = '', replyToMessageId }, file) {
  const context = await sendContext(req, id, { needsWindow: true });
  const info = mediaService.classify(file);
  if (caption && info.type === 'audio') {
    throw httpError(400, 'VALIDATION_ERROR', 'WhatsApp does not show a caption on audio files.', [{ field: 'caption', code: 'NO_CAPTION', message: 'Send the text as a separate message.' }]);
  }
  const replyTo = await replyTarget(context.conversation, replyToMessageId);
  const storageKey = await documentStorage.put(context.conversation.organizationId, file.buffer);
  const fields = {
    type: info.type,
    text: caption,
    media: { mimeType: info.mimeType, fileName: info.fileName, sizeBytes: file.buffer.length, storageKey, sha256: mediaService.sha256Hex(file.buffer) },
    replyToProviderMessageId: replyTo || undefined,
  };
  return deliver(req, context, fields, async (message) => {
    const { mediaId } = await providerFor(context.account).uploadMedia(credentials(context.account), { buffer: file.buffer, mimeType: info.mimeType, fileName: info.fileName });
    message.media.providerMediaId = mediaId;
    return {
      type: info.type,
      [info.type]: { id: mediaId, ...(caption && { caption }), ...(info.type === 'document' && { filename: info.fileName }) },
      ...quoting(replyTo),
    };
  });
}

// The file of a message in a chat the member can see.
async function openMedia(req, id, messageId) {
  const conversation = await findVisible(req, id);
  const message = await Message.findOne({ _id: messageId, conversationId: conversation._id, organizationId: conversation.organizationId });
  if (!message) throw httpError(404, 'NOT_FOUND', 'Message not found');
  return mediaService.open(message);
}

// Opens (or finds) the chat with a contact on one of the organization's numbers, e.g. to send
// a template to a lead who has not written yet. A new chat is assigned to the person who opens it.
async function start(req, { contactId, accountId }) {
  const organizationId = req.tenant.organizationId;
  const contact = await Contact.findOne({ _id: contactId, organizationId, ...visibilityFilter(req, ['customers', 'leads', 'inbox']) });
  if (!contact) throw httpError(404, 'NOT_FOUND', 'Contact not found');
  if (!contact.phoneE164) throw httpError(400, 'NO_PHONE', 'Add a mobile number to this contact first.');
  const account = accountId
    ? await WhatsAppAccount.findOne({ _id: accountId, organizationId })
    : await WhatsAppAccount.findOne({ organizationId }).sort({ isDefault: -1, createdAt: 1 });
  if (!account) throw httpError(400, 'NO_WHATSAPP_NUMBER', 'Add a WhatsApp number in Settings → WhatsApp first.');

  const existing = await Conversation.findOne({ organizationId, contactId: contact._id, whatsappAccountId: account._id });
  if (existing) {
    if (!seesAll(req.member) && existing.assigneeId && String(existing.assigneeId) !== String(req.member._id)) {
      throw httpError(409, 'CHAT_ASSIGNED', 'A teammate is handling this customer\'s WhatsApp chat.');
    }
    return { conversation: await loadSerialized(existing._id), created: false };
  }
  const conversation = await Conversation.findOneAndUpdate(
    { organizationId, contactId: contact._id, whatsappAccountId: account._id },
    { $setOnInsert: { status: 'open', assigneeId: req.member._id } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  await audit(req, { action: 'conversation.started', entityType: 'Conversation', entityId: conversation._id, changes: { contactId: contact._id } });
  announce('conversation:updated', conversation, { previousAssigneeId: null });
  return { conversation: await loadSerialized(conversation._id), created: true };
}

async function listNotes(req, id) {
  const conversation = await findVisible(req, id);
  return noteService.list(req, 'conversation', conversation._id);
}

async function addNote(req, id, body) {
  const conversation = await findVisible(req, id);
  const note = await noteService.add(req, 'conversation', conversation._id, body);
  bus.emit('note:new', { organizationId: conversation.organizationId, conversation, note });
  return note;
}

module.exports = {
  list, summary, get, update, markRead, listMessages, sendText, sendTemplate, sendMedia, openMedia, start, listNotes, addNote,
  serializeConversation, serializeMessage, serviceWindow, seesAll,
};
