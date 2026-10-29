const Joi = require('joi');
const { GSTIN_PATTERN } = require('../utils/gstin');
const { objectId } = require('./common');

// Tax invoices, credit notes and receipts (D101).
const text = (max) => Joi.string().trim().max(max).allow('');
const variables = Joi.object({
  header: Joi.object().pattern(/^[A-Za-z0-9_]{1,60}$/, Joi.string().allow('').max(1024)),
  body: Joi.object().pattern(/^[A-Za-z0-9_]{1,60}$/, Joi.string().allow('').max(1024)),
  buttons: Joi.object().pattern(/^\d{1,2}$/, Joi.string().allow('').max(1024)),
});

module.exports = {
  // The customer's details may be put right before the invoice is made (it is never edited after).
  invoiceCreate: Joi.object({
    billTo: Joi.object({
      name: Joi.string().trim().min(1).max(200),
      company: text(200),
      gstin: Joi.string().trim().uppercase().pattern(GSTIN_PATTERN).allow('')
        .messages({ 'string.pattern.base': 'GSTIN must be 15 characters, for example 08ABCDE1234F1Z5' }),
      address: text(500),
      city: text(100),
      state: text(100),
      postalCode: text(12),
    }),
  }),
  // In full, or some lines: a quantity returned or an amount off the taxable value.
  creditNote: Joi.object({
    full: Joi.boolean().default(false),
    lines: Joi.when('full', {
      is: true,
      then: Joi.forbidden(),
      otherwise: Joi.array().items(Joi.object({
        index: Joi.number().integer().min(0).max(199).required(),
        quantity: Joi.number().positive().max(1e9),
        taxablePaise: Joi.number().integer().positive().max(1e13),
      }).xor('quantity', 'taxablePaise')).min(1).max(200).required(),
    }),
    reason: Joi.string().trim().min(3).max(500).required()
      .messages({ 'any.required': 'Say why the credit note is made', 'string.empty': 'Say why the credit note is made', 'string.min': 'Say why the credit note is made' }),
  }),
  // The PDF as a document (24-hour window) or an approved template (any time).
  documentSend: Joi.object({
    mode: Joi.string().valid('document', 'template').required(),
    caption: Joi.when('mode', { is: 'document', then: Joi.string().trim().max(1024).allow(''), otherwise: Joi.forbidden() }),
    templateId: Joi.when('mode', { is: 'template', then: objectId.required(), otherwise: Joi.forbidden() }),
    variables: Joi.when('mode', { is: 'template', then: variables.default({}), otherwise: Joi.forbidden() }),
  }),
};
