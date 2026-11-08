const Joi = require('joi');

// Phase 8 (D120): a customer's data on request, and the company's privacy settings.
const day = Joi.string().trim().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'Use a day like 2026-11-08.' });
const language = Joi.string().valid('en', 'hi').default('en');

module.exports = {
  // POST /contacts/:id/privacy/export
  exportFile: Joi.object({
    format: Joi.string().valid('html', 'json').default('html'),
    language,
    askedAt: day.allow(''),
  }),
  // POST /contacts/:id/privacy/erase
  erase: Joi.object({
    confirmName: Joi.string().trim().max(200).required(),
    askedAt: day.allow(''),
    language,
  }),
  // PUT /organization/privacy; '' clears a field.
  settings: Joi.object({
    contactName: Joi.string().trim().max(100).allow(''),
    contactEmail: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(200).allow(''),
    contactPhone: Joi.string().trim().max(30).pattern(/^[0-9+()\-\s]*$/).allow('').messages({ 'string.pattern.base': 'Use digits, spaces and + only.' }),
    noticeUrl: Joi.string().trim().max(500).uri({ scheme: ['https', 'http'] }).allow('').messages({ 'string.uri': 'Enter the full address, starting with https://' }),
    deviceCopies: Joi.boolean(),
    requestsBy: Joi.string().valid('managers', 'owners'),
  }).min(1),
  requests: Joi.object({
    page: Joi.number().integer().min(1).max(1000).default(1),
    limit: Joi.number().integer().min(1).max(100).default(50),
  }),
  // GET /organization/privacy/customers?q= — deleted customers too.
  find: Joi.object({ q: Joi.string().trim().min(2).max(100).required() }),
};
