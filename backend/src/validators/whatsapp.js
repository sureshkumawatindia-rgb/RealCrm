const Joi = require('joi');
const { objectId } = require('./common');
const { WHATSAPP_PROVIDERS, TEMPLATE_CATEGORIES } = require('../constants/whatsapp');

const numericId = Joi.string().trim().pattern(/^\d{5,30}$/).messages({ 'string.pattern.base': 'Use the number from the Meta app (digits only)' });
const secret = Joi.string().trim().min(10).max(1000);

module.exports = {
  accountCreate: Joi.object({
    name: Joi.string().trim().max(100).allow(''),
    provider: Joi.string().valid(...WHATSAPP_PROVIDERS).default('meta'),
    // "mock" numbers get a made-up id; Meta numbers need the real one.
    phoneNumberId: Joi.when('provider', { is: 'mock', then: Joi.string().trim().max(60).allow(''), otherwise: numericId }),
    wabaId: Joi.alternatives(numericId, Joi.string().valid('')),
    accessToken: secret,
    appSecret: Joi.string().trim().min(16).max(200),
  }),
  accountPatch: Joi.object({
    name: Joi.string().trim().max(100).allow(''),
    wabaId: Joi.alternatives(numericId, Joi.string().valid('')),
    accessToken: secret,
    appSecret: Joi.string().trim().min(16).max(200),
    isDefault: Joi.boolean().valid(true),
  }).min(1),
  // A made-up incoming text, or (test numbers only) a photo, document or voice note with an
  // optional caption.
  simulateInbound: Joi.object({
    accountId: objectId,
    from: Joi.string().trim().max(30).required(),
    name: Joi.string().trim().max(100).allow(''),
    type: Joi.string().valid('text', 'image', 'document', 'audio').default('text'),
    text: Joi.when('type', { is: 'text', then: Joi.string().trim().min(1).max(4096).required(), otherwise: Joi.string().trim().max(1024).allow('') }),
  }),
  clickToChat: Joi.object({
    accountId: objectId,
    text: Joi.string().trim().max(500).allow(''),
  }),
  templateList: Joi.object({
    accountId: objectId,
    status: Joi.string().trim().uppercase().pattern(/^[A-Z_]{1,30}$/),
  }),
  templateSync: Joi.object({
    accountId: objectId,
  }),
  templateCreate: Joi.object({
    accountId: objectId,
    name: Joi.string().trim().pattern(/^[a-z0-9_]{1,512}$/).required()
      .messages({ 'string.pattern.base': 'Use lower-case letters, digits and "_" only (for example order_update)' }),
    language: Joi.string().trim().pattern(/^[a-z]{2,3}(_[A-Z]{2})?$/).required()
      .messages({ 'string.pattern.base': 'Use a WhatsApp language code such as en, en_US or hi' }),
    category: Joi.string().trim().uppercase().valid(...TEMPLATE_CATEGORIES).required(),
    headerText: Joi.string().trim().max(60).allow(''),
    headerExample: Joi.string().trim().max(200).allow(''),
    bodyText: Joi.string().trim().min(1).max(1024).required(),
    bodyExamples: Joi.object().pattern(/^[A-Za-z0-9_]{1,60}$/, Joi.string().trim().max(200).allow('')).max(20),
    footerText: Joi.string().trim().max(60).allow(''),
    buttons: Joi.array().max(3).items(Joi.object({
      type: Joi.string().valid('QUICK_REPLY', 'URL', 'PHONE_NUMBER').required(),
      text: Joi.string().trim().min(1).max(25).required(),
      url: Joi.when('type', { is: 'URL', then: Joi.string().trim().uri({ scheme: ['https', 'http'] }).max(2000).required(), otherwise: Joi.forbidden() }),
      phoneNumber: Joi.when('type', { is: 'PHONE_NUMBER', then: Joi.string().trim().max(30).required(), otherwise: Joi.forbidden() }),
    })),
  }),
};
