const Joi = require('joi');
const { PLAN_KEYS } = require('../constants/plans');
const { INCIDENT_SERVICES, INCIDENT_LEVELS } = require('../constants/serviceStatus');

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
  // D118: the support contact in every company's help; '' clears a field.
  support: Joi.object({
    whatsapp: Joi.string().trim().max(20).allow('').default(''),
    email: Joi.string().trim().lowercase().email().max(200).allow('').default(''),
    hours: Joi.string().trim().max(120).allow('').default(''),
  }),
  // D151: a notice on the status page and in the CRM's banners.
  notice: Joi.object({
    service: Joi.string().valid(...INCIDENT_SERVICES).default('notice'),
    level: Joi.string().valid(...INCIDENT_LEVELS).required(),
    title: Joi.object({ en: Joi.string().trim().min(3).max(120).required(), hi: Joi.string().trim().min(3).max(120).required() }).required(),
    body: Joi.object({ en: Joi.string().trim().max(500).allow(''), hi: Joi.string().trim().max(500).allow('') }),
    untilHours: Joi.number().integer().min(1).max(168),
  }),
  emails: Joi.object({
    status: Joi.string().valid('queued', 'sent', 'failed', 'skipped'),
    limit: Joi.number().integer().min(1).max(200).default(50),
  }),
};
