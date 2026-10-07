const Joi = require('joi');
const { PLAN_KEYS } = require('../constants/plans');

// Paying for the CRM plan (Phase 10B).
module.exports = {
  checkout: Joi.object({ plan: Joi.string().valid(...PLAN_KEYS).required() }),
};
