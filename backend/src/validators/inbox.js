const Joi = require('joi');
const { objectId } = require('./common');
const { paginationQuery } = require('../utils/pagination');
const { CONVERSATION_STATUSES } = require('../constants/whatsapp');

// Template variable values by variable name ("1", "customer_name") or button index.
const variableValues = Joi.object().pattern(/^[A-Za-z0-9_]{1,60}$/, Joi.string().allow('').max(1024)).max(50);

module.exports = {
  conversationList: Joi.object({
    ...paginationQuery,
    view: Joi.string().valid('mine', 'unassigned', 'all').default('all'),
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
  }).min(1),
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
  }),
  quickReplyPatch: Joi.object({
    shortcut: Joi.string().trim().lowercase().pattern(/^[a-z0-9_-]{1,30}$/)
      .messages({ 'string.pattern.base': 'Use 1–30 letters, digits, "-" or "_" (no spaces)' }),
    title: Joi.string().trim().max(100).allow(''),
    body: Joi.string().trim().min(1).max(4096),
  }).min(1),
};
