const Joi = require('joi');
const { GSTIN_PATTERN } = require('../utils/gstin');

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
  }).min(1),
};
