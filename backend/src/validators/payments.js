const Joi = require('joi');
const { objectId } = require('./common');
const { paginationQuery } = require('../utils/pagination');
const { PAYMENT_PROVIDER_KEYS, LINK_STATUSES, MANUAL_PAYMENT_METHODS, MAX_EXPIRY_DAYS } = require('../constants/payments');

// Keys are pasted from the gateways' dashboards: Razorpay rzp_test_…/rzp_live_…, Cashfree app ids.
const keyId = Joi.string().trim().pattern(/^[A-Za-z0-9_.-]{6,100}$/).messages({ 'string.pattern.base': 'This does not look like a key id.' });
const secret = Joi.string().trim().min(6).max(300);
const paise = Joi.number().integer().min(1).max(100000000000);

module.exports = {
  connectionCreate: Joi.object({
    provider: Joi.string().valid(...PAYMENT_PROVIDER_KEYS).required(),
    name: Joi.string().trim().max(80).allow(''),
    keyId: Joi.when('provider', { is: 'mock', then: Joi.forbidden(), otherwise: keyId.required() }),
    keySecret: Joi.when('provider', { is: 'mock', then: Joi.forbidden(), otherwise: secret.required() }),
    // Razorpay signs webhooks with a secret of your choice; Cashfree uses the key secret.
    webhookSecret: Joi.when('provider', { is: 'razorpay', then: secret.required(), otherwise: Joi.forbidden() }),
    mode: Joi.when('provider', { is: 'cashfree', then: Joi.string().valid('test', 'live').default('test'), otherwise: Joi.forbidden() }),
  }),
  connectionPatch: Joi.object({
    name: Joi.string().trim().max(80).allow(''),
    keyId,
    keySecret: secret,
    webhookSecret: secret,
    mode: Joi.string().valid('test', 'live'),
    isDefault: Joi.boolean().valid(true),
  }).min(1),
  settings: Joi.object({
    expiryDays: Joi.number().integer().min(1).max(MAX_EXPIRY_DAYS),
    sendReceipt: Joi.boolean(),
    linkTemplateId: objectId.allow(null, ''),
    receiptTemplateId: objectId.allow(null, ''),
  }).min(1),
  linkCreate: Joi.object({
    orderId: objectId,
    quotationId: objectId,
    contactId: objectId,
    amountPaise: paise,
    description: Joi.string().trim().max(500).allow(''),
    acceptPartial: Joi.boolean().default(false),
    minPartialPaise: paise,
    expiresInDays: Joi.number().integer().min(1).max(MAX_EXPIRY_DAYS),
    connectionId: objectId,
  }).xor('orderId', 'quotationId', 'contactId')
    .messages({ 'object.xor': 'Make the link for one order, quotation or customer.', 'object.missing': 'Make the link for an order, a quotation or a customer.' }),
  linkList: Joi.object({
    ...paginationQuery,
    status: Joi.string().valid(...LINK_STATUSES),
    orderId: objectId,
    quotationId: objectId,
    contactId: objectId,
  }),
  manualPayment: Joi.object({
    amountPaise: paise.required(),
    method: Joi.string().valid(...MANUAL_PAYMENT_METHODS).required(),
    reference: Joi.string().trim().max(120).allow(''),
    paidAt: Joi.date().max('now').allow(null, '').empty(''),
  }),
  paymentParams: Joi.object({ id: objectId.required(), paymentId: objectId.required() }),
};
