const Joi = require('joi');
const { PLAN_KEYS } = require('../constants/plans');

// The platform admin page (D104).
module.exports = {
  unlock: Joi.object({ code: Joi.string().trim().min(6).max(20).required() }),
  companies: Joi.object({
    q: Joi.string().trim().max(100).allow('').default(''),
    status: Joi.string().valid('', 'trialing', 'paying', 'past_due', 'locked', 'comped', 'cancelled').default(''),
    page: Joi.number().integer().min(1).max(1000).default(1),
    limit: Joi.number().integer().min(1).max(100).default(50),
  }),
  // comp | trial (days from now, 1–365) | plan (another plan by hand)
  action: Joi.object({
    action: Joi.string().valid('comp', 'trial', 'plan').required(),
    days: Joi.when('action', { is: 'trial', then: Joi.number().integer().min(1).max(365).required(), otherwise: Joi.forbidden() }),
    plan: Joi.when('action', { is: 'plan', then: Joi.string().valid(...PLAN_KEYS).required(), otherwise: Joi.forbidden() }),
  }),
  emails: Joi.object({
    status: Joi.string().valid('queued', 'sent', 'failed', 'skipped'),
    limit: Joi.number().integer().min(1).max(200).default(50),
  }),
};
