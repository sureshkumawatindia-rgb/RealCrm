const Joi = require('joi');
const { objectId } = require('./common');
const { CALL_DIRECTIONS, CALL_OUTCOMES } = require('../constants/calls');
const { KINDS } = require('../services/timelineService');

// Calls, Settings → Calling and the customer history (Phase 6, D85).
module.exports = {
  callLog: Joi.object({
    contactId: objectId.required(),
    leadId: objectId,
    direction: Joi.string().valid(...CALL_DIRECTIONS).default('out'),
    outcome: Joi.string().valid(...CALL_OUTCOMES).required(),
    durationSec: Joi.number().integer().min(0).max(86400).default(0),
    at: Joi.date().iso().max('now'),
    notes: Joi.string().trim().max(2000).allow(''),
  }),
  callPatch: Joi.object({
    outcome: Joi.string().valid(...CALL_OUTCOMES),
    notes: Joi.string().trim().max(2000).allow(''),
    durationSec: Joi.number().integer().min(0).max(86400),
  }).min(1),
  callDial: Joi.object({ contactId: objectId.required(), leadId: objectId }),
  callList: Joi.object({ contactId: objectId, leadId: objectId, memberId: objectId, from: Joi.date().iso(), to: Joi.date().iso(), limit: Joi.number().integer().min(1).max(200).default(50) }),
  telephonySave: Joi.object({
    provider: Joi.string().valid('exotel', 'mock').required(),
    accountSid: Joi.when('provider', { is: 'exotel', then: Joi.string().trim().max(100).required(), otherwise: Joi.string().trim().max(100).allow('') }),
    apiKey: Joi.string().trim().max(200).allow(''),
    apiToken: Joi.string().trim().max(200).allow(''),
    subdomain: Joi.string().trim().lowercase().pattern(/^[a-z0-9.-]+\.exotel\.com$/).max(100).allow('').messages({ 'string.pattern.base': 'The subdomain is an exotel.com address, e.g. api.exotel.com' }),
    callerId: Joi.string().trim().max(30).allow(''),
  }),
  timeline: Joi.object({
    kinds: Joi.array().items(Joi.string().valid(...Object.keys(KINDS))).single().max(6),
    before: Joi.string().max(80),
    limit: Joi.number().integer().min(1).max(100).default(30),
  }),
};
