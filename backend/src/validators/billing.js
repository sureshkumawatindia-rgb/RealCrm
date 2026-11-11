const Joi = require('joi');
const { PLAN_KEYS, BILLING_INTERVALS } = require('../constants/plans');

// Paying for the CRM plan (Phase 10B; monthly or yearly since D125), and the usage history (Phase 3A).
module.exports = {
  checkout: Joi.object({
    plan: Joi.string().valid(...PLAN_KEYS).required(),
    interval: Joi.string().valid(...BILLING_INTERVALS).default('monthly'),
  }),
  usageHistory: Joi.object({ days: Joi.number().integer().min(7).max(400).default(30) }),
};
