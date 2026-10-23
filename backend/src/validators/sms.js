const Joi = require('joi');
const { objectId } = require('./common');
const { SMS_PROVIDERS, MAX_SMS_TEMPLATES } = require('../constants/sms');

// SMS to customers (Phase 8A, D88).
const template = Joi.object({
  key: Joi.string().trim().max(20).allow(''),
  name: Joi.string().trim().min(1).max(80).required().label('Template name'),
  flowId: Joi.string().trim().max(64).allow('').label('MSG91 template id'),
  dltTemplateId: Joi.string().trim().pattern(/^\d{0,40}$/).allow('').label('DLT template id').messages({ 'string.pattern.base': 'The DLT template id is digits only.' }),
  text: Joi.string().trim().min(1).max(1000).required().label('Approved text'),
});

module.exports = {
  connectionSave: Joi.object({
    provider: Joi.string().valid(...SMS_PROVIDERS).required(),
    authKey: Joi.string().trim().max(200).allow(''),
    senderId: Joi.string().trim().pattern(/^[A-Za-z]{6}$/).allow('').label('Sender ID').messages({ 'string.pattern.base': 'The sender ID is 6 letters (your DLT header).' }),
    templates: Joi.array().items(template).max(MAX_SMS_TEMPLATES).default([]),
  }),
  smsSend: Joi.object({
    contactId: objectId.required(),
    leadId: objectId,
    template: Joi.string().trim().max(20).required(),
    values: Joi.object().pattern(/^[A-Za-z0-9_]{1,30}$/, Joi.string().trim().max(100).allow('')).default({}),
  }),
  smsList: Joi.object({ contactId: objectId.required() }),
  smsConsent: Joi.object({ optedOut: Joi.boolean().required() }),
};
