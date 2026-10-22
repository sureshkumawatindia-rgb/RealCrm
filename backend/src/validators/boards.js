const Joi = require('joi');
const { objectId } = require('./common');
const { LEAD_STAGES, LEAD_SOURCES, TASK_STATUSES, TASK_PRIORITIES } = require('../constants/crm');
const { BOARD_LAYOUTS, BOARD_OBJECT_KEYS, MAX_COLUMNS } = require('../constants/boards');

// Boards (Phase 7B, D87). Columns, group-by and date field are checked against the object by the
// service (custom fields are the company's own); filters are checked here per object.
const owner = Joi.alternatives(Joi.string().valid('me'), objectId);
const FILTERS = {
  lead: Joi.object({
    q: Joi.string().trim().max(100).allow(''),
    stages: Joi.array().items(Joi.string().valid(...LEAD_STAGES)).max(LEAD_STAGES.length).unique(),
    sources: Joi.array().items(Joi.string().valid(...LEAD_SOURCES)).max(LEAD_SOURCES.length).unique(),
    ownerId: owner,
  }),
  task: Joi.object({
    q: Joi.string().trim().max(100).allow(''),
    statuses: Joi.array().items(Joi.string().valid(...TASK_STATUSES)).max(TASK_STATUSES.length).unique(),
    priorities: Joi.array().items(Joi.string().valid(...TASK_PRIORITIES)).max(TASK_PRIORITIES.length).unique(),
    assigneeId: owner,
  }),
};

const fields = {
  name: Joi.string().trim().min(1).max(80),
  layout: Joi.string().valid(...BOARD_LAYOUTS),
  filters: Joi.object().unknown(true),
  columns: Joi.array().items(Joi.string().trim().max(80)).max(MAX_COLUMNS).unique(),
  groupBy: Joi.string().trim().max(80).allow(''),
  dateField: Joi.string().trim().max(80).allow(''),
  sort: Joi.string().trim().max(40).allow(''),
  shared: Joi.boolean(),
};

module.exports = {
  FILTERS,
  boardCreate: Joi.object({ ...fields, object: Joi.string().valid(...BOARD_OBJECT_KEYS).required(), name: fields.name.required() }),
  boardPatch: Joi.object(fields).min(1),
  boardList: Joi.object({ object: Joi.string().valid(...BOARD_OBJECT_KEYS) }),
  boardItems: Joi.object({ from: Joi.date().iso(), to: Joi.date().iso(), page: Joi.number().integer().min(1).max(1000).default(1) }),
};
