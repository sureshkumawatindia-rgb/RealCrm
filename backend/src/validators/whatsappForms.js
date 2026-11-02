const Joi = require('joi');
const { objectId } = require('./common');

// WhatsApp forms (G6, D110): the texts within WhatsApp's limits (a label's 20 characters, a date's
// 40, are checked by kind in services/whatsappFormService.js).
const text = (max) => Joi.string().trim().max(max).allow('');
const field = Joi.object({
  key: Joi.string().pattern(/^[a-zA-Z]{1,20}$/).required(),
  label: Joi.string().trim().min(1).max(40),
  on: Joi.boolean(),
  required: Joi.boolean(),
});
const base = {
  name: Joi.string().trim().min(1).max(60),
  intro: text(1024),
  cta: Joi.string().trim().min(1).max(30),
  heading: Joi.string().trim().min(1).max(80),
  submitLabel: Joi.string().trim().min(1).max(35),
  thanks: text(1024),
  fields: Joi.array().items(field).max(20),
  productIds: Joi.array().items(objectId).max(100).unique(),
};

module.exports = {
  create: Joi.object({ kind: Joi.string().valid('enquiry', 'order').required(), ...base, name: base.name.required() }),
  update: Joi.object(base).min(1),
};
