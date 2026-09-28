const Joi = require('joi');
const { objectId } = require('./common');
const { paginationQuery } = require('../utils/pagination');
const { CONVERSATION_STATUSES } = require('../constants/whatsapp');

module.exports = {
  conversationList: Joi.object({
    ...paginationQuery,
    view: Joi.string().valid('mine', 'unassigned', 'all').default('all'),
    status: Joi.string().valid(...CONVERSATION_STATUSES, 'any'),
    accountId: objectId,
    q: Joi.string().trim().max(100).allow(''),
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
  messageSend: Joi.object({
    // Media and templates come with the template/media checkpoint (3D).
    type: Joi.string().valid('text').default('text'),
    text: Joi.string().trim().min(1).max(4096).required(),
    replyToMessageId: objectId,
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
