const Joi = require('joi');
const { objectId } = require('./common');
const { LEAD_SOURCES } = require('../constants/crm');
const { QUERY_TYPES } = require('../integrations/leadSources/indiamart');

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

// IndiaMART: which kinds of leads to take (W, B, P, WA, BIZ).
const indiamartSettings = Joi.object({
  queryTypes: Joi.array().items(Joi.string().valid(...Object.keys(QUERY_TYPES))).min(1).unique(),
});
const apiKey = Joi.string().trim().min(10).max(300).pattern(/^\S+$/).messages({ 'string.pattern.base': 'Paste the key without spaces' });

const pageToken = Joi.string().trim().min(20).max(1000).pattern(/^\S+$/).messages({ 'string.pattern.base': 'Paste the token without spaces' });
const appSecret = Joi.string().trim().min(16).max(200);
const only = (type, schema) => Joi.when('type', { is: type, then: schema, otherwise: Joi.forbidden() });

module.exports = {
  // Website forms (4A), IndiaMART (4B), Facebook Lead Ads, Google Ads, JustDial and TradeIndia (4C).
  connectionCreate: Joi.object({
    type: Joi.string().valid('website', 'indiamart', 'facebook', 'googleads', 'justdial', 'tradeindia').required(),
    name: text(100),
    apiKey: only('indiamart', apiKey),
    pageId: only('facebook', Joi.string().trim().pattern(/^\d{5,30}$/).required().messages({ 'string.pattern.base': 'Use the Page ID (digits only)' })),
    pageAccessToken: only('facebook', pageToken.required()),
    appSecret: only('facebook', appSecret.required()),
    settings: Joi.when('type', {
      switch: [{ is: 'website', then: websiteSettings }, { is: 'indiamart', then: indiamartSettings }],
      otherwise: Joi.forbidden(),
    }),
  }),
  connectionPatch: Joi.object({
    name: text(100),
    status: Joi.string().valid('active', 'paused'),
    apiKey,
    pageAccessToken: pageToken,
    appSecret,
    settings: Joi.alternatives().try(websiteSettings, indiamartSettings),
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
