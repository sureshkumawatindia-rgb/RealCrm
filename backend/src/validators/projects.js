const Joi = require('joi');
const { objectId } = require('./common');
const { paginationQuery } = require('../utils/pagination');
const { TASK_PRIORITIES, TASK_STATUSES } = require('../constants/crm');
const { PROJECT_STATUSES, MAX_MILESTONES, MAX_TEMPLATE_TASKS, MAX_TEAM } = require('../constants/projects');

// Projects after the sale (Phase 10, D92).
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('');
const fields = {
  name: Joi.string().trim().min(1).max(120),
  status: Joi.string().valid(...PROJECT_STATUSES),
  managerId: objectId,
  memberIds: Joi.array().items(objectId).max(MAX_TEAM).unique(),
  startDate: day,
  dueDate: day,
  description: Joi.string().trim().max(2000).allow(''),
  valuePaise: Joi.number().integer().min(0).max(1e13),
};
const templateFields = {
  name: Joi.string().trim().min(1).max(80),
  days: Joi.number().integer().min(0).max(730),
  milestones: Joi.array().items(Joi.object({ name: Joi.string().trim().min(1).max(120).required(), dueAfterDays: Joi.number().integer().min(0).max(730).default(0) })).max(MAX_MILESTONES),
  tasks: Joi.array().items(Joi.object({
    title: Joi.string().trim().min(1).max(300).required(),
    milestone: Joi.number().integer().min(0).allow(null).default(null),
    dueAfterDays: Joi.number().integer().min(0).max(730).default(0),
    priority: Joi.string().valid(...TASK_PRIORITIES).default('Medium'),
    forManager: Joi.boolean().default(true),
  })).max(MAX_TEMPLATE_TASKS),
};

module.exports = {
  projectCreate: Joi.object({ ...fields, name: fields.name.required(), leadId: objectId, contactId: objectId, templateId: objectId }),
  projectPatch: Joi.object(fields).min(1),
  projectList: Joi.object({ ...paginationQuery, q: Joi.string().trim().max(100).allow(''), status: Joi.string().valid(...PROJECT_STATUSES), managerId: objectId, leadId: objectId, contactId: objectId, mine: Joi.boolean() }),
  startFromLead: Joi.object({ templateId: objectId, name: Joi.string().trim().min(1).max(120), startDate: day, managerId: objectId }),
  milestoneCreate: Joi.object({ name: Joi.string().trim().min(1).max(120).required(), dueDate: day.default('') }),
  milestonePatch: Joi.object({ name: Joi.string().trim().min(1).max(120), dueDate: day, done: Joi.boolean() }).min(1),
  milestoneParams: Joi.object({ id: objectId.required(), milestoneId: objectId.required() }),
  taskCreate: Joi.object({ title: Joi.string().trim().min(1).max(300).required(), dueDate: day, priority: Joi.string().valid(...TASK_PRIORITIES), assigneeId: objectId.allow(null), milestoneId: objectId.allow(null) }),
  taskPatch: Joi.object({ title: Joi.string().trim().min(1).max(300), dueDate: day, status: Joi.string().valid(...TASK_STATUSES), assigneeId: objectId.allow(null) }).min(1),
  taskParams: Joi.object({ id: objectId.required(), taskId: objectId.required() }),
  summary: Joi.object({ leadId: objectId, contactId: objectId }).xor('leadId', 'contactId'),
  templateCreate: Joi.object({ ...templateFields, name: templateFields.name.required() }),
  templatePatch: Joi.object(templateFields).min(1),
  settings: Joi.object({ onWon: Joi.object({ enabled: Joi.boolean().required(), templateId: objectId.allow(null) }).required() }),
};
