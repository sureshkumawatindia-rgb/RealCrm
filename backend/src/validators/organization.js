const Joi = require('joi');
const { GSTIN_PATTERN } = require('../utils/gstin');
const { CODE_PATTERN } = require('../utils/workspaceCode');

const text = (max) => Joi.string().trim().max(max).allow('');

module.exports = {
  organizationPatch: Joi.object({
    name: Joi.string().trim().min(1).max(200),
    industry: text(100),
    size: text(50),
    foundedYear: Joi.alternatives(Joi.number().integer().min(1800).max(2100), Joi.valid(null, '')),
    website: text(300),
    email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254).allow(''),
    phone: text(30),
    gstin: Joi.string().trim().uppercase().pattern(GSTIN_PATTERN).allow('')
      .messages({ 'string.pattern.base': 'GSTIN must be 15 characters, for example 08ABCDE1234F1Z5' }),
    address: text(500),
    city: text(100),
    state: text(100),
    country: text(100),
    postalCode: text(12),
    description: text(2000),
    // The workspace code the team types on the login page (D66).
    slug: Joi.string().trim().lowercase().pattern(CODE_PATTERN)
      .messages({ 'string.pattern.base': 'Use 2 to 40 small letters, numbers and hyphens, for example sharma-traders' }),
  }).min(1),

  // Settings → Billing (Phase 5): what quotations show and how documents are numbered.
  billing: Joi.object({
    bank: Joi.object({
      accountName: text(200),
      accountNumber: Joi.string().trim().pattern(/^[0-9]{6,20}$/).allow('').messages({ 'string.pattern.base': 'Account number: 6 to 20 digits' }),
      ifsc: Joi.string().trim().uppercase().pattern(/^[A-Z]{4}0[A-Z0-9]{6}$/).allow('').messages({ 'string.pattern.base': 'IFSC is 11 characters, for example SBIN0001234' }),
      bankName: text(200),
      branch: text(200),
    }),
    upiId: Joi.string().trim().pattern(/^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,64}$/).allow('')
      .messages({ 'string.pattern.base': 'A UPI ID looks like yourshop@okaxis' }),
    terms: text(5000),
    validityDays: Joi.number().integer().min(1).max(365),
    prefixes: Joi.object(Object.fromEntries(['quotation', 'estimate', 'proforma', 'order'].map((key) => [key,
      Joi.string().trim().uppercase().pattern(/^[A-Z0-9][A-Z0-9-]{0,9}$/).messages({ 'string.pattern.base': 'Prefixes: up to 10 letters, digits or dashes' })]))),
    roundOff: Joi.boolean(),
    reduceStockOnDispatch: Joi.boolean(),
  }).min(1),
};
