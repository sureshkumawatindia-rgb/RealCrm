const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const OrganizationMember = require('../models/OrganizationMember');
const httpError = require('../utils/httpError');
const logger = require('../config/logger');
const bus = require('../realtime/bus');
const { audit } = require('../utils/audit');
const { toPage, paginationMeta } = require('../utils/pagination');
const { isManager, canViewAll } = require('../constants/permissions');
const { SERVICE_WINDOW_MS } = require('../constants/whatsapp');
const { OPEN_STAGES } = require('../constants/crm');
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
    // The FAQ bot (Phase 6C): handedOffAt = it waits for a person in this chat.
    bot: { handedOffAt: conversation.bot?.handedOffAt || null, handoffReason: conversation.bot?.handoffReason || '' },
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
    interactive: message.interactive?.kind
      ? {
        kind: message.interactive.kind, listButton: message.interactive.listButton || '', footer: message.interactive.footer || '', options: message.interactive.options || [],
        ...(message.interactive.products?.length && { products: message.interactive.products }),
      }
      : null,
    order: message.order?.items?.length
      ? { catalogId: message.order.catalogId || '', text: message.order.text || '', items: message.order.items, orderId: message.order.orderId || null }
      : null,
    // Meta's message id (wamid): lets the page show which message a reply quotes.
    providerMessageId: message.providerMessageId || null,
    // history (imported) or phone (sent from the WhatsApp Business app), D60.
    origin: message.origin || null,
    replyToProviderMessageId: message.replyToProviderMessageId || null,
    status: message.status,
    sentAt: message.sentAt || null,
    deliveredAt: message.deliveredAt || null,
    readAt: message.readAt || null,
    failedAt: message.failedAt || null,
    error: message.error?.message || message.error?.title ? message.error : null,
    sentByMemberId: message.sentByMemberId || null,
    automation: message.automation?.kind ? { kind: message.automation.kind, ruleId: message.automation.ruleId || null } : null,
    at: message.providerTimestamp || message.createdAt,
    createdAt: message.createdAt,
  };
}

const POPULATE = [
  { path: 'contactId', select: 'name phone phoneE164 company' },
  { path: 'whatsappAccountId', select: 'name displayPhone verifiedName phoneNumberId' },
];

// D25: whoever handles a chat becomes the owner of its contact and the contact's open leads when
// nobody owns them yet (WhatsApp leads start without one). A teammate's record is never taken.
async function claimCustomer(conversation, memberId) {
  if (!memberId) return;
  const unowned = { organizationId: conversation.organizationId, ownerId: null };
  await Promise.all([
    Contact.updateOne({ ...unowned, _id: conversation.contactId }, { $set: { ownerId: memberId } }),
    Lead.updateMany({ ...unowned, contactId: conversation.contactId, stage: { $in: OPEN_STAGES } }, { $set: { ownerId: memberId } }),
  ]);
}

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
  // A closed chat starts afresh: the FAQ bot may answer the customer's next message again.
  if (body.status === 'closed' && conversation.bot?.handedOffAt) conversation.set({ 'bot.handedOffAt': undefined, 'bot.handoffReason': undefined });
  if ('tags' in body) conversation.tags = [...new Set(body.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
  await conversation.save();
  if (conversation.assigneeId && String(conversation.assigneeId) !== String(previousAssigneeId)) await claimCustomer(conversation, conversation.assigneeId);
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

// Who sends: a member (their first reply takes an unassigned chat), or the CRM itself
// (auto-replies: no sender, never takes the chat).
const asMember = (req) => ({ memberId: req.member._id, takesChat: true });
const AS_SYSTEM = Object.freeze({ memberId: null, takesChat: false });

// The message is saved first (queued), then handed to WhatsApp: accepted → sent, refused →
// failed with WhatsApp's reason (the message stays in the chat either way). buildBody(message)
// returns the Cloud API message object (it may upload a file first).
async function deliver(sender, { conversation, account, contact }, fields, buildBody) {
  const message = await Message.create({
    organizationId: conversation.organizationId, conversationId: conversation._id, contactId: contact._id,
    whatsappAccountId: account._id, direction: 'out', status: 'queued', ...(sender.memberId && { sentByMemberId: sender.memberId }), ...fields,
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
  const takes = sender.takesChat && !conversation.assigneeId;
  if (takes) set.assigneeId = sender.memberId;
  const updated = await Conversation.findOneAndUpdate({ _id: conversation._id }, { $set: set }, { returnDocument: 'after' });
  bus.emit('message:new', { organizationId: conversation.organizationId, conversation: updated, message });
  if (takes) {
    await claimCustomer(updated, sender.memberId);
    announce('conversation:updated', updated, { previousAssigneeId: null });
  }
  return serializeMessage(message);
}

async function sendText(req, id, { text, replyToMessageId }) {
  const context = await sendContext(req, id, { needsWindow: true });
  const replyTo = await replyTarget(context.conversation, replyToMessageId);
  return deliver(asMember(req), context, { type: 'text', text, replyToProviderMessageId: replyTo || undefined }, async () => ({
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
  return deliver(asMember(req), context, { type: 'template', text, template: { name: template.name, language: template.language, variables: values } }, async () => ({
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
  return deliver(asMember(req), context, fields, async (message) => {
    const { mediaId } = await providerFor(context.account).uploadMedia(credentials(context.account), { buffer: file.buffer, mimeType: info.mimeType, fileName: info.fileName });
    message.media.providerMediaId = mediaId;
    return {
      type: info.type,
      [info.type]: { id: mediaId, ...(caption && { caption }), ...(info.type === 'document' && { filename: info.fileName }) },
      ...quoting(replyTo),
    };
  });
}

// A PDF the CRM made (a quotation): as a document with a caption inside the 24-hour window, or
// in an approved template outside it — a DOCUMENT header carries the PDF (Meta allows only
// PDFs there); a text-only template goes without it. A copy stays in the CRM's storage.
async function sendGeneratedDocument(req, id, { buffer, fileName, caption = '', templateId, variables }) {
  const context = await sendContext(req, id, { needsWindow: !templateId });
  let template = null;
  let shape = null;
  if (templateId) {
    template = await templateService.findSendable(req.tenant.organizationId, templateId);
    if (String(template.whatsappAccountId) !== String(context.account._id)) {
      throw httpError(400, 'VALIDATION_ERROR', 'This template belongs to another WhatsApp number.', [{ field: 'templateId', code: 'OTHER_NUMBER', message: 'Pick a template of this chat\'s number.' }]);
    }
    shape = templateService.shapeOf(template, { withDocument: true });
    if (!shape.sendable) throw httpError(422, 'TEMPLATE_NOT_SENDABLE', shape.notSendableReason);
  }
  // Check the variables before anything is stored or uploaded.
  const checked = template ? templateService.buildSend(template, variables, shape.documentHeader ? { document: { id: 'pending', filename: fileName } } : {}) : null;
  const withFile = !template || shape.documentHeader;
  const media = withFile
    ? { mimeType: 'application/pdf', fileName, sizeBytes: buffer.length, storageKey: await documentStorage.put(context.conversation.organizationId, buffer), sha256: mediaService.sha256Hex(buffer) }
    : undefined;
  const upload = async (message) => {
    const { mediaId } = await providerFor(context.account).uploadMedia(credentials(context.account), { buffer, mimeType: 'application/pdf', fileName });
    message.media.providerMediaId = mediaId;
    return mediaId;
  };
  if (!template) {
    return deliver(asMember(req), context, { type: 'document', text: caption, media }, async (message) => {
      const mediaId = await upload(message);
      return { type: 'document', document: { id: mediaId, filename: fileName, ...(caption && { caption }) } };
    });
  }
  const fields = { type: 'template', text: checked.text, template: { name: template.name, language: template.language, variables: checked.values }, ...(media && { media }) };
  return deliver(asMember(req), context, fields, async (message) => {
    if (!shape.documentHeader) return { type: 'template', template: checked.payload };
    const mediaId = await upload(message);
    return { type: 'template', template: templateService.buildSend(template, variables, { document: { id: mediaId, filename: fileName } }).payload };
  });
}

// The chat of a contact on a number, opened if needed (auto-replies). A new chat goes to
// assigneeId (the lead's owner); an existing unassigned one is given to them too.
async function ensureConversation({ organizationId, contactId, accountId, assigneeId = null }) {
  let conversation = await Conversation.findOneAndUpdate(
    { organizationId, contactId, whatsappAccountId: accountId },
    { $setOnInsert: { status: 'open', assigneeId } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  if (assigneeId && !conversation.assigneeId) {
    conversation = await Conversation.findOneAndUpdate({ _id: conversation._id, assigneeId: null }, { $set: { assigneeId } }, { returnDocument: 'after' }) || conversation;
    announce('conversation:updated', conversation, { previousAssigneeId: null });
  }
  return conversation;
}

// A template sent by the CRM itself (auto-reply rules). automation: { kind, ruleId }.
async function sendTemplateAutomatically({ conversation, template, variables, automation }) {
  const [account, contact] = await Promise.all([
    WhatsAppAccount.findOne({ _id: conversation.whatsappAccountId, organizationId: conversation.organizationId }),
    Contact.findOne({ _id: conversation.contactId, organizationId: conversation.organizationId }),
  ]);
  if (!account) throw httpError(409, 'NUMBER_REMOVED', 'The WhatsApp number was removed from Settings.');
  if (!contact?.phoneE164) throw httpError(409, 'NO_PHONE', 'This contact has no WhatsApp number.');
  const { payload, text, values } = templateService.buildSend(template, variables);
  return deliver(AS_SYSTEM, { conversation, account, contact }, {
    type: 'template', text, template: { name: template.name, language: template.language, variables: values }, automation,
  }, async () => ({ type: 'template', template: payload }));
}

// A text the CRM sends itself (automations), only inside the 24-hour window.
async function sendTextAutomatically({ conversation, text, automation }) {
  if (!serviceWindow(conversation).open) {
    throw httpError(422, 'WINDOW_CLOSED', 'The customer has not written in the last 24 hours; only an approved template can go now.');
  }
  const [account, contact] = await Promise.all([
    WhatsAppAccount.findOne({ _id: conversation.whatsappAccountId, organizationId: conversation.organizationId }),
    Contact.findOne({ _id: conversation.contactId, organizationId: conversation.organizationId }),
  ]);
  if (!account) throw httpError(409, 'NUMBER_REMOVED', 'The WhatsApp number was removed from Settings.');
  if (!contact?.phoneE164) throw httpError(409, 'NO_PHONE', 'This contact has no WhatsApp number.');
  return deliver(AS_SYSTEM, { conversation, account, contact }, { type: 'text', text, automation }, async () => ({
    type: 'text', text: { body: text, preview_url: /https?:\/\//i.test(text) },
  }));
}

// Buttons (1–3) or a list (4–10 options) the CRM sends itself (the FAQ bot), only inside the
// 24-hour window. interactive: { kind: button | list, body, footer?, listButton?, options [{ id, title, description? }] }.
async function sendInteractiveAutomatically({ conversation, interactive, automation }) {
  if (!serviceWindow(conversation).open) {
    throw httpError(422, 'WINDOW_CLOSED', 'The customer has not written in the last 24 hours; only an approved template can go now.');
  }
  const [account, contact] = await Promise.all([
    WhatsAppAccount.findOne({ _id: conversation.whatsappAccountId, organizationId: conversation.organizationId }),
    Contact.findOne({ _id: conversation.contactId, organizationId: conversation.organizationId }),
  ]);
  if (!account) throw httpError(409, 'NUMBER_REMOVED', 'The WhatsApp number was removed from Settings.');
  if (!contact?.phoneE164) throw httpError(409, 'NO_PHONE', 'This contact has no WhatsApp number.');
  const { kind, body, footer = '', listButton = 'Choose', options } = interactive;
  const fields = { type: 'interactive', text: body, interactive: { kind, listButton: kind === 'list' ? listButton : undefined, footer: footer || undefined, options }, automation };
  return deliver(AS_SYSTEM, { conversation, account, contact }, fields, async () => ({
    type: 'interactive',
    interactive: kind === 'button'
      ? {
        type: 'button', body: { text: body }, ...(footer && { footer: { text: footer } }),
        action: { buttons: options.map((o) => ({ type: 'reply', reply: { id: o.id, title: o.title } })) },
      }
      : {
        type: 'list', body: { text: body }, ...(footer && { footer: { text: footer } }),
        action: { button: listButton, sections: [{ title: listButton, rows: options.map((o) => ({ id: o.id, title: o.title, ...(o.description && { description: o.description }) })) }] },
      },
  }));
}

// Products from the number's WhatsApp catalog (Phase 8C), sent by a member inside the 24-hour
// window: one product, or a list (header required) in sections of at most 30 products in all.
// products: [{ productId, retailerId, name, section }].
async function sendProducts(req, id, { catalogId, products, header = '', body, footer = '' }) {
  const context = await sendContext(req, id, { needsWindow: true });
  const single = products.length === 1;
  const sections = [];
  for (const product of products) {
    const title = String(product.section || 'Products').slice(0, 24);
    let section = sections.find((s) => s.title === title);
    if (!section) {
      section = { title, product_items: [] };
      sections.push(section);
    }
    section.product_items.push({ product_retailer_id: product.retailerId });
  }
  const text = body || (single ? products[0].name : header);
  const fields = {
    type: 'interactive', text,
    interactive: { kind: single ? 'product' : 'product_list', footer: footer || undefined, products: products.map(({ productId, retailerId, name }) => ({ productId, retailerId, name })) },
  };
  return deliver(asMember(req), context, fields, async () => ({
    type: 'interactive',
    interactive: single
      ? { type: 'product', ...(body && { body: { text: body } }), ...(footer && { footer: { text: footer } }), action: { catalog_id: catalogId, product_retailer_id: products[0].retailerId } }
      : {
        type: 'product_list', header: { type: 'text', text: header }, body: { text: body || header }, ...(footer && { footer: { text: footer } }),
        action: { catalog_id: catalogId, sections: sections.slice(0, 10) },
      },
  }));
}

// A teammate turns the FAQ bot off (it waits for a person) or back on in one chat.
async function setBot(req, id, { active }) {
  const conversation = await findVisible(req, id);
  if (active) conversation.set({ 'bot.handedOffAt': undefined, 'bot.handoffReason': undefined });
  else conversation.set({ 'bot.handedOffAt': new Date(), 'bot.handoffReason': `Paused by ${req.user.name}` });
  await conversation.save();
  await audit(req, { action: active ? 'conversation.bot_on' : 'conversation.bot_off', entityType: 'Conversation', entityId: conversation._id });
  announce('conversation:updated', conversation, { previousAssigneeId: conversation.assigneeId || null });
  return loadSerialized(conversation._id);
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
  await claimCustomer(conversation, conversation.assigneeId);
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
  ensureConversation, sendTemplateAutomatically, sendTextAutomatically, sendInteractiveAutomatically, sendGeneratedDocument, sendProducts, announce, findVisible, setBot,
  serializeConversation, serializeMessage, serviceWindow, seesAll,
};
