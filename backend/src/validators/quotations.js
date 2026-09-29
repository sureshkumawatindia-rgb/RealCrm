const Joi = require('joi');
const { objectId } = require('./common');
const { paginationQuery } = require('../utils/pagination');
const { GSTIN_PATTERN } = require('../utils/gstin');
const { QUOTATION_STATUSES, QUOTATION_TYPES } = require('../constants/crm');
const { GST_STATES } = require('../constants/gst');

const text = (max) => Joi.string().trim().max(max).allow('');
const paise = Joi.number().integer().min(0).max(1e13);
const stateCode = Joi.string().valid(...GST_STATES.map((s) => s.code), '');
const gstin = Joi.string().trim().uppercase().pattern(GSTIN_PATTERN).allow('')
  .messages({ 'string.pattern.base': 'GSTIN must be 15 characters, for example 08ABCDE1234F1Z5' });

// One line as the editor sends it. Missing name, HSN, unit, price or rate come from the product.
const item = Joi.object({
  productId: objectId.allow(null),
  name: text(200),
  description: text(1000),
  hsnSac: Joi.string().trim().pattern(/^[0-9]{0,8}$/).allow('').messages({ 'string.pattern.base': 'HSN/SAC is up to 8 digits' }),
  unit: text(20),
  quantity: Joi.number().greater(0).max(1e9).required(),
  unitPricePaise: paise,
  discountType: Joi.string().valid('amount', 'percent').default('amount'),
  discountValue: Joi.when('discountType', { is: 'percent', then: Joi.number().min(0).max(100), otherwise: paise }).default(0),
  gstRatePct: Joi.number().min(0).max(100),
}).custom((value, helpers) => (value.productId || value.name ? value : helpers.message('Each line needs a product or a name')));

const billTo = Joi.object({
  name: text(200), company: text(200), phone: text(30), email: text(254), gstin,
  address: text(500), city: text(100), state: text(100), stateCode, postalCode: text(12),
});

const content = {
  items: Joi.array().items(item).min(1).max(200),
  billTo,
  placeOfSupplyCode: stateCode,
  zeroRated: Joi.boolean(),
  validUntil: Joi.date().allow(null, '').empty(''),
  terms: text(5000),
  notes: text(2000),
};
const customer = { leadId: objectId, contactId: objectId, conversationId: objectId };

module.exports = {
  quotationCreate: Joi.object({ ...customer, ...content, type: Joi.string().valid(...QUOTATION_TYPES).default('Quotation'), items: content.items.required() })
    .or('leadId', 'contactId', 'conversationId'),
  quotationPatch: Joi.object({
    ...content,
    type: Joi.string().valid(...QUOTATION_TYPES),
    status: Joi.string().valid(...QUOTATION_STATUSES.filter((s) => !['Draft', 'Viewed', 'Expired'].includes(s))),
    rejectedReason: text(500),
  }).min(1),
  pricingPreview: Joi.object({ ...customer, ...content, items: content.items.required(), roundOff: Joi.boolean() }),
  quotationList: Joi.object({
    ...paginationQuery,
    leadId: objectId,
    contactId: objectId,
    status: Joi.string().valid(...QUOTATION_STATUSES),
    type: Joi.string().valid(...QUOTATION_TYPES),
    q: Joi.string().trim().max(100).allow(''),
  }),
};
