const Joi = require('joi');
const { objectId } = require('./common');
const { paginationQuery } = require('../utils/pagination');
const { GSTIN_PATTERN } = require('../utils/gstin');
const { LEAD_STAGES, QUOTATION_STATUSES, ORDER_STAGES } = require('../constants/crm');
const { API_SCOPE_KEYS, WEBHOOK_EVENT_KEYS } = require('../constants/api');

// The public API and its settings (Phase 10C).
const text = (max) => Joi.string().trim().max(max).allow('');
const templateValues = Joi.object().pattern(Joi.string().max(60), Joi.alternatives(Joi.string().max(1024), Joi.number())).max(30);
const list = (extra = {}) =>Joi.object({ ...paginationQuery, updatedSince: Joi.date().iso(), ...extra });

const contactFields = {
  name: Joi.string().trim().min(1).max(200),
  phone: text(30),
  email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254).allow(''),
  company: text(200),
  gstin: Joi.string().trim().uppercase().pattern(GSTIN_PATTERN).allow('')
    .messages({ 'string.pattern.base': 'GSTIN must be 15 characters, for example 08ABCDE1234F1Z5' }),
  city: text(100),
  state: text(100),
  address: text(500),
  tags: Joi.array().items(Joi.string().trim().max(50)).max(30).unique(),
  lifecycle: Joi.string().valid('lead', 'customer'),
  marketingConsent: Joi.string().valid('unknown', 'opted_in', 'opted_out'),
  notes: text(5000),
};

module.exports = {
  apiKeyCreate: Joi.object({
    name: Joi.string().trim().min(1).max(100).required(),
    scopes: Joi.array().items(Joi.string().valid(...API_SCOPE_KEYS)).min(1).unique().required(),
  }),
  webhookCreate: Joi.object({
    url: Joi.string().trim().uri({ scheme: ['https', 'http'] }).max(2000).required(),
    events: Joi.array().items(Joi.string().valid(...WEBHOOK_EVENT_KEYS)).min(1).unique().required(),
    description: text(200),
  }),
  webhookPatch: Joi.object({
    url: Joi.string().trim().uri({ scheme: ['https', 'http'] }).max(2000),
    events: Joi.array().items(Joi.string().valid(...WEBHOOK_EVENT_KEYS)).min(1).unique(),
    description: text(200),
    active: Joi.boolean(),
  }).min(1),
  deliveryList: Joi.object({ ...paginationQuery, status: Joi.string().valid('pending', 'delivered', 'failed') }),

  // --- /api/public/v1 ---
  contactList: list({ search: Joi.string().trim().max(100), phone: Joi.string().trim().max(30), email: Joi.string().trim().max(254) }),
  contactCreate: Joi.object({ ...contactFields, name: contactFields.name.required() }),
  contactPatch: Joi.object(contactFields).min(1),
  leadList: list({ stage: Joi.string().valid(...LEAD_STAGES), source: Joi.string().trim().max(50) }),
  leadCreate: Joi.object({
    contact: Joi.object({ name: text(200), phone: text(30), email: text(254), company: text(200), city: text(100), state: text(100), address: text(500) }).required(),
    title: text(200),
    product: text(200),
    quantity: Joi.alternatives(Joi.number().min(0), text(50)),
    message: text(1500),
    externalId: Joi.string().trim().max(200),
  }),
  leadStage: Joi.object({ stage: Joi.string().valid(...LEAD_STAGES).required(), lostReason: text(500) }),
  quotationList: list({ status: Joi.string().valid(...QUOTATION_STATUSES), contactId: objectId }),
  orderList: list({ stage: Joi.string().valid(...ORDER_STAGES), contactId: objectId }),
  productList: list({ active: Joi.boolean() }),
  messageSend: Joi.object({
    contactId: objectId,
    phone: Joi.string().trim().max(30),
    name: text(200),
    template: Joi.object({ name: Joi.string().trim().max(512).required(), language: Joi.string().trim().max(20) }).required(),
    // The template's {{…}} values: { header: { name: value }, body: { "1": value } or { name: value }, buttons: { "0": link end } }.
    variables: Joi.object({
      header: templateValues,
      body: templateValues,
      buttons: templateValues,
    }),
  }).xor('contactId', 'phone'),
};
