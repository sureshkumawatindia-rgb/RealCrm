const Joi = require('joi');
const { objectId } = require('./common');
const { LEAD_SOURCES } = require('../constants/crm');
const { validTimeZone, minutesOf } = require('../utils/businessHours');

const time = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).messages({ 'string.pattern.base': 'Use a time like 09:30' });
const names = Joi.array().items(Joi.string().trim().min(1).max(100)).max(50);
const sources = Joi.array().items(Joi.string().valid(...LEAD_SOURCES)).max(LEAD_SOURCES.length).unique();
// What fills a template variable: a CRM value, or fixed text written as "text:…".
const variableSpec = Joi.string().trim().max(205);
const variables = Joi.object({
  header: Joi.object().pattern(/^[A-Za-z0-9_]{1,60}$/, variableSpec),
  body: Joi.object().pattern(/^[A-Za-z0-9_]{1,60}$/, variableSpec),
  buttons: Joi.object().pattern(/^\d{1,2}$/, variableSpec),
});

const assignmentFields = {
  name: Joi.string().trim().max(100).allow(''),
  active: Joi.boolean(),
  priority: Joi.number().integer().min(0).max(10000),
  conditions: Joi.object({
    sources,
    productIds: Joi.array().items(objectId).max(100).unique(),
    states: names,
    cities: names,
  }),
  strategy: Joi.string().valid('round_robin', 'specific'),
  memberIds: Joi.array().items(objectId).max(100).unique(),
  respectWorkingHours: Joi.boolean(),
  fallbackMemberId: objectId.allow(null),
};

const autoReplyFields = {
  name: Joi.string().trim().max(100).allow(''),
  active: Joi.boolean(),
  priority: Joi.number().integer().min(0).max(10000),
  sources,
  onlyNewContacts: Joi.boolean(),
  maxAgeMinutes: Joi.number().integer().min(0).max(7 * 24 * 60),
  delaySeconds: Joi.number().integer().min(0).max(3600),
  templateId: objectId,
  variables,
};

module.exports = {
  businessHours: Joi.object({
    timezone: Joi.string().trim().max(60).default('Asia/Kolkata').custom((value, helpers) => (validTimeZone(value) ? value : helpers.message('Use a time zone like Asia/Kolkata'))),
    days: Joi.array().items(Joi.number().integer().min(0).max(6)).min(1).max(7).unique().required(),
    start: time.required(),
    end: time.required(),
  }).custom((value, helpers) => (minutesOf(value.end) > minutesOf(value.start) ? value : helpers.message('The day must end after it starts'))),
  assignmentRuleCreate: Joi.object({ ...assignmentFields, memberIds: assignmentFields.memberIds.min(1).required() }),
  assignmentRulePatch: Joi.object(assignmentFields).min(1),
  autoReplyRuleCreate: Joi.object({ ...autoReplyFields, templateId: objectId.required() }),
  autoReplyRulePatch: Joi.object(autoReplyFields).min(1),
  historyQuery: Joi.object({ leadId: objectId.required() }),
};
