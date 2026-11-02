const Joi = require('joi');
const { RELATED_TYPES } = require('../constants/crm');

// Google Workspace (Phase 9, D90).
module.exports = {
  connect: Joi.object({
    features: Joi.array().items(Joi.string().valid('calendar', 'drive')).max(2).unique().default([]),
    returnUrl: Joi.string().trim().max(2000).allow(''),
  }),
  connectionPatch: Joi.object({ shareEmails: Joi.boolean() }).min(1),
  threadParams: Joi.object({ threadId: Joi.string().trim().pattern(/^[A-Za-z0-9_-]{1,100}$/).required() }),
  messages: Joi.object({ limit: Joi.number().integer().min(1).max(50).default(10), q: Joi.string().trim().max(300).allow('').default('') }),
  // Google Sheets (G4, D108): new leads or orders into a sheet, optionally from the last 30 days.
  sheetSyncStart: Joi.object({ kind: Joi.string().valid('leads', 'orders').required(), backfillDays: Joi.number().valid(0, 30).default(0) }),
  sheetSyncKind: Joi.object({ kind: Joi.string().valid('leads', 'orders').required() }),
  driveFile: Joi.object({
    kind: Joi.string().valid('doc', 'sheet').required(),
    name: Joi.string().trim().min(1).max(200).required(),
    relatedType: Joi.string().valid(...RELATED_TYPES.filter(Boolean)).required(),
    relatedId: Joi.string().hex().length(24).required(),
  }),
};
