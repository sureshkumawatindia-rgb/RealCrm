const Joi = require('joi');
const { PLAN_KEYS } = require('../constants/plans');

// Paying for the CRM plan (Phase 10B), and the usage history (Phase 3A).
module.exports = {
  checkout: Joi.object({ plan: Joi.string().valid(...PLAN_KEYS).required() }),
  usageHistory: Joi.object({ days: Joi.number().integer().min(7).max(400).default(30) }),
};
