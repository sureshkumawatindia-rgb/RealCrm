const Joi = require('joi');
const { objectId } = require('./common');
const { paginationQuery } = require('../utils/pagination');
const { GSTIN_PATTERN } = require('../utils/gstin');
const { LEAD_STAGES, LEAD_SOURCES, CONTACT_LIFECYCLES, CONTACT_STATUSES, QUOTATION_STATUSES } = require('../constants/crm');

const text = (max) => Joi.string().trim().max(max).allow('');
// null clears the reference (e.g. "no product").
const optionalId = objectId.allow(null);
const paise = Joi.number().integer().min(0).max(1e13);
const listBase = { ...paginationQuery, q: Joi.string().trim().max(100).allow(''), sort: Joi.string().max(40) };

const contactFields = {
  name: Joi.string().trim().min(1).max(200),
  email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254).allow(''),
  phone: text(30),
  company: text(200),
  gstin: Joi.string().trim().uppercase().pattern(GSTIN_PATTERN).allow('')
    .messages({ 'string.pattern.base': 'GSTIN must be 15 characters, for example 08ABCDE1234F1Z5' }),
  state: text(100),
  city: text(100),
  address: text(500),
  tags: Joi.array().items(Joi.string().trim().max(50)).max(30).unique(),
  source: Joi.string().valid(...LEAD_SOURCES),
  lifecycle: Joi.string().valid(...CONTACT_LIFECYCLES),
  status: Joi.string().valid(...CONTACT_STATUSES),
  productIds: Joi.array().items(objectId).max(20).unique(),
  notes: text(5000),
  ownerId: objectId.allow(null),
};

const noteEntry = Joi.object({
  id: Joi.string().trim().max(60).required(),
  title: text(200),
  text: text(5000),
  createdAt: Joi.date(),
});

const leadFields = {
  title: text(200),
  stage: Joi.string().valid(...LEAD_STAGES),
  lostReason: text(500),
  source: Joi.string().valid(...LEAD_SOURCES),
  productId: optionalId,
  quantity: Joi.number().min(0).max(1e9).allow(null),
  expectedValuePaise: paise.allow(null),
  expectedCloseDate: Joi.date().allow(null, '').empty(''),
  followUpAt: Joi.date().allow(null, '').empty(''),
  ownerId: objectId.allow(null),
  notes: text(5000),
  noteEntries: Joi.array().items(noteEntry).max(200),
};

const leadContact = {
  name: Joi.string().trim().min(1).max(200),
  email: contactFields.email,
  phone: contactFields.phone,
  company: contactFields.company,
};

module.exports = {
  contactCreate: Joi.object({ ...contactFields, name: contactFields.name.required() }),
  contactPatch: Joi.object(contactFields).min(1),
  contactList: Joi.object({
    ...listBase,
    lifecycle: Joi.string().valid(...CONTACT_LIFECYCLES),
    status: Joi.string().valid(...CONTACT_STATUSES),
    ownerId: objectId,
    tag: Joi.string().trim().max(50),
  }),

  productCreate: Joi.object({
    name: Joi.string().trim().min(1).max(200).required(),
    sku: text(100),
    category: text(100),
    description: text(2000),
    unit: text(20),
    hsnSac: Joi.string().trim().pattern(/^\d{4,8}$/).allow('')
      .messages({ 'string.pattern.base': 'HSN/SAC code must be 4 to 8 digits' }),
    pricePaise: paise,
    gstRatePct: Joi.number().min(0).max(100),
    moq: Joi.number().integer().min(0).allow(null),
    stockQty: Joi.number().integer().min(0).allow(null),
    images: Joi.array().items(Joi.string().uri({ scheme: ['http', 'https'] })).max(10),
    active: Joi.boolean(),
  }),
  productList: Joi.object({ ...listBase, category: Joi.string().trim().max(100), active: Joi.boolean() }),

  leadCreate: Joi.object({
    ...leadFields,
    contactId: objectId,
    contact: Joi.object({ ...leadContact, name: leadContact.name.required() }),
  }).xor('contactId', 'contact'),
  leadPatch: Joi.object({ ...leadFields, contact: Joi.object(leadContact).min(1), version: Joi.number().integer().min(0) }).min(1),
  leadStage: Joi.object({
    stage: Joi.string().valid(...LEAD_STAGES).required(),
    lostReason: text(500),
    version: Joi.number().integer().min(0),
  }),
  leadList: Joi.object({
    ...listBase,
    stage: Joi.string().valid(...LEAD_STAGES),
    ownerId: objectId,
    productId: objectId,
    contactId: objectId,
    followUpFrom: Joi.date(),
    followUpTo: Joi.date(),
  }),
  leadNote: Joi.object({ text: Joi.string().trim().min(1).max(5000).required(), type: Joi.string().trim().max(40).default('Note') }),

  quotationDraft: Joi.object({
    items: Joi.array().items(Joi.object({
      productId: optionalId,
      name: text(200),
      quantity: Joi.number().greater(0).max(1e9).required(),
      unitPricePaise: paise.required(),
      discountPaise: paise.default(0),
      taxRatePct: Joi.number().min(0).max(100).default(0),
    })).min(1).max(100).required(),
    validUntil: Joi.date().allow(null, '').empty(''),
  }),
  quotationList: Joi.object({
    ...paginationQuery,
    leadId: objectId,
    contactId: objectId,
    status: Joi.string().valid(...QUOTATION_STATUSES),
  }),
  quotationPatch: Joi.object({ status: Joi.string().valid(...QUOTATION_STATUSES).required() }),
};
