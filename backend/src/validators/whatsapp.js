const Joi = require('joi');
const { objectId } = require('./common');
const { WHATSAPP_PROVIDERS } = require('../constants/whatsapp');

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
  simulateInbound: Joi.object({
    accountId: objectId,
    from: Joi.string().trim().max(30).required(),
    name: Joi.string().trim().max(100).allow(''),
    text: Joi.string().trim().min(1).max(4096).required(),
  }),
};
