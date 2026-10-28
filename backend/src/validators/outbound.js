const Joi = require('joi');
const { objectId } = require('./common');
const { LEAD_STAGES } = require('../constants/crm');
const { CALL_OUTCOMES } = require('../constants/calls');

// The power dialer and bulk actions (Phase 8B, D89).
const variableSpec = Joi.string().trim().max(205);
const PARAMS = {
  assign: Joi.object({ ownerId: objectId.allow(null).required() }),
  stage: Joi.object({ stage: Joi.string().valid(...LEAD_STAGES).required(), lostReason: Joi.when('stage', { is: 'Lost', then: Joi.string().trim().min(1).max(500).required(), otherwise: Joi.string().trim().max(500).allow('') }) }),
  followUp: Joi.object({ at: Joi.date().iso().allow(null).required() }),
  tag: Joi.object({ tag: Joi.string().trim().min(1).max(50).required() }),
  untag: Joi.object({ tag: Joi.string().trim().min(1).max(50).required() }), // D100
  sequence: Joi.object({ sequenceId: objectId.required() }),
  sms: Joi.object({ template: Joi.string().trim().min(1).max(20).required(), variables: Joi.object().pattern(/^[A-Za-z0-9_]{1,30}$/, variableSpec).default({}) }),
  delete: Joi.object({}), // D100
};
// Customers (D100): the same settings, fewer actions.
const CONTACT_ACTIONS = ['assign', 'tag', 'untag', 'sequence', 'delete'];

// Up to 5,000 rows (D100): more than 200 go to a background job. runAutomations: a stage change
// also starts the company's workflows (off unless ticked).
const bulkBody = (actions) => Joi.object({
  action: Joi.string().valid(...actions).required(),
  ids: Joi.array().items(objectId).min(1).max(5000).required(),
  params: Joi.object().unknown(true).default({}),
  runAutomations: Joi.boolean().default(false),
}).custom((value, helpers) => {
  const { error, value: params } = PARAMS[value.action].validate(value.params, { stripUnknown: true });
  return error ? helpers.message(error.message.replace(/"/g, '')) : { ...value, params };
});

module.exports = {
  PARAMS,
  bulkLeads: bulkBody(Object.keys(PARAMS)),
  bulkContacts: bulkBody(CONTACT_ACTIONS),
  sessionCreate: Joi.object({ leadIds: Joi.array().items(objectId).max(200), boardId: objectId, name: Joi.string().trim().max(80).allow('') }).xor('leadIds', 'boardId'),
  itemParams: Joi.object({ id: objectId.required(), n: Joi.number().integer().min(0).max(199).required() }),
  itemResult: Joi.object({
    outcome: Joi.string().valid(...CALL_OUTCOMES).required(),
    notes: Joi.string().trim().max(2000).allow(''),
    minutes: Joi.number().min(0).max(600),
    followUpInDays: Joi.number().integer().min(0).max(90).allow(null),
  }),
  itemSkip: Joi.object({ reason: Joi.string().trim().max(200).allow('') }),
};
