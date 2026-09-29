const Joi = require('joi');
const { objectId } = require('./common');
const { LEAD_SOURCES } = require('../constants/crm');

const text = (max) => Joi.string().trim().max(max).allow('');
// A website address like https://www.example.com (no path): where a form may be embedded.
const origin = Joi.string().trim().lowercase().pattern(/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/)
  .messages({ 'string.pattern.base': 'Use a website address like https://www.example.com (no path)' });

const websiteSettings = Joi.object({
  title: text(120),
  buttonText: text(40),
  successMessage: text(300),
  redirectUrl: Joi.string().trim().uri({ scheme: ['https', 'http'] }).max(500).allow(''),
  allowedOrigins: Joi.array().items(origin).max(20),
  askFor: Joi.object({
    email: Joi.boolean(), company: Joi.boolean(), city: Joi.boolean(), product: Joi.boolean(), message: Joi.boolean(),
  }),
});

module.exports = {
  // Phase 4A: website forms; the other types arrive with their checkpoints.
  connectionCreate: Joi.object({
    type: Joi.string().valid('website').required(),
    name: text(100),
    settings: websiteSettings,
  }),
  connectionPatch: Joi.object({
    name: text(100),
    status: Joi.string().valid('active', 'paused'),
    settings: websiteSettings,
  }).min(1),
  intakeList: Joi.object({
    limit: Joi.number().integer().min(1).max(100).default(20),
  }),
  // What a website form sends (JSON from embed.js, or a plain HTML form post).
  formSubmit: Joi.object({
    name: Joi.string().trim().min(1).max(120).required(),
    phone: text(30),
    email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254).allow(''),
    company: text(200),
    city: text(100),
    product: text(200),
    quantity: text(50),
    message: text(2000),
    submissionId: Joi.string().trim().pattern(/^[A-Za-z0-9-]{8,64}$/),
    website_url: Joi.any(), // honeypot: people never see it, bots fill it in
  }).unknown(true),
  simulateLead: Joi.object({
    source: Joi.string().valid(...LEAD_SOURCES).default('IndiaMART'),
    sourceRef: text(200),
    name: Joi.string().trim().max(120).allow(''),
    phone: text(30),
    email: text(254),
    company: text(200),
    city: text(100),
    state: text(100),
    product: text(200),
    quantity: text(50),
    message: text(2000),
  }),
  connectionId: Joi.object({ id: objectId.required() }),
};
