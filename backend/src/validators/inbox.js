const Joi = require('joi');
const { objectId } = require('./common');
const { paginationQuery } = require('../utils/pagination');
const { CONVERSATION_STATUSES } = require('../constants/whatsapp');

// Template variable values by variable name ("1", "customer_name") or button index.
const variableValues = Joi.object().pattern(/^[A-Za-z0-9_]{1,60}$/, Joi.string().allow('').max(1024)).max(50);

module.exports = {
  conversationList: Joi.object({
    ...paginationQuery,
    view: Joi.string().valid('mine', 'unassigned', 'all', 'archived', 'blocked').default('all'), // D103: blocked
    status: Joi.string().valid(...CONVERSATION_STATUSES, 'any'),
    accountId: objectId,
    contactId: objectId,
    q: Joi.string().trim().max(100).allow(''),
  }),
  conversationStart: Joi.object({
    contactId: objectId.required(),
    accountId: objectId,
  }),
  conversationPatch: Joi.object({
    status: Joi.string().valid(...CONVERSATION_STATUSES),
    assigneeId: objectId.allow(null),
    tags: Joi.array().items(Joi.string().trim().max(40)).max(20),
    pinned: Joi.boolean(), // for the member who asks (CP3)
    archived: Joi.boolean(), // for the whole company
  }).min(1),
  // A reaction on a message of the chat (CP3): one emoji.
  reaction: Joi.object({
    emoji: Joi.string().trim().min(1).max(16).required(),
  }),
  messageList: Joi.object({
    before: objectId,
    limit: Joi.number().integer().min(1).max(100),
  }),
  // A text (inside the 24-hour window) or an approved template (any time). Files use
  // POST /conversations/:id/messages/media.
  messageSend: Joi.object({
    type: Joi.string().valid('text', 'template').default('text'),
    text: Joi.when('type', { is: 'text', then: Joi.string().trim().min(1).max(4096).required(), otherwise: Joi.forbidden() }),
    replyToMessageId: Joi.when('type', { is: 'text', then: objectId, otherwise: Joi.forbidden() }),
    templateId: Joi.when('type', { is: 'template', then: objectId.required(), otherwise: Joi.forbidden() }),
    variables: Joi.when('type', {
      is: 'template',
      then: Joi.object({ header: variableValues, body: variableValues, buttons: variableValues }).default({}),
      otherwise: Joi.forbidden(),
    }),
  }),
  // Form fields next to the file.
  mediaSend: Joi.object({
    caption: Joi.string().trim().max(1024).allow(''),
    replyToMessageId: objectId,
    voice: Joi.boolean().truthy('true', '1').falsy('false', '0'), // a recorded voice note (CP3)
  }),
  messageParams: Joi.object({
    id: objectId.required(),
    messageId: objectId.required(),
  }),
  quickReplyCreate: Joi.object({
    shortcut: Joi.string().trim().lowercase().pattern(/^[a-z0-9_-]{1,30}$/).required()
      .messages({ 'string.pattern.base': 'Use 1–30 letters, digits, "-" or "_" (no spaces)' }),
    title: Joi.string().trim().max(100).allow(''),
    body: Joi.string().trim().min(1).max(4096).required(),
    documentId: objectId.allow(null, ''), // D103: a file from Documents
  }),
  quickReplyPatch: Joi.object({
    shortcut: Joi.string().trim().lowercase().pattern(/^[a-z0-9_-]{1,30}$/)
      .messages({ 'string.pattern.base': 'Use 1–30 letters, digits, "-" or "_" (no spaces)' }),
    title: Joi.string().trim().max(100).allow(''),
    body: Joi.string().trim().min(1).max(4096),
    documentId: objectId.allow(null, ''), // D103: a file from Documents (null: none)
  }).min(1),
  // A quick reply filled for one chat's customer (D99).
  quickReplyFill: Joi.object({ conversationId: objectId.required() }),
  // D103: a quick reply's file with its text (the caption, or a message first when longer).
  quickReplyFile: Joi.object({
    quickReplyId: objectId.required(),
    caption: Joi.string().trim().max(4096).allow(''),
    replyToMessageId: objectId,
  }),
  // D103: send later — a text and when (checked: 1 minute to 30 days ahead).
  scheduleCreate: Joi.object({
    text: Joi.string().trim().min(1).max(4096).required(),
    sendAt: Joi.date().iso().required(),
  }),
  schedulePatch: Joi.object({
    text: Joi.string().trim().min(1).max(4096),
    sendAt: Joi.date().iso(),
  }).min(1),
  // D103: blocking the chat's customer.
  block: Joi.object({ reason: Joi.string().trim().max(200).allow('') }),
  // Products from the WhatsApp catalog (Phase 8C): one, or a list of up to 30 with a heading.
  productsSend: Joi.object({
    productIds: Joi.array().items(objectId).min(1).max(30).unique().required(),
    header: Joi.string().trim().max(60).allow(''),
    body: Joi.string().trim().max(1024).allow(''),
  }),
};
