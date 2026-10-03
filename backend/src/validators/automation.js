const Joi = require('joi');
const { objectId } = require('./common');
const { paginationQuery } = require('../utils/pagination');
const { LEAD_STAGES, LEAD_SOURCES, ORDER_STAGES, AUTOMATION_STATUSES, TASK_PRIORITIES } = require('../constants/crm');
const { TRIGGER_TYPES, CONDITION_FIELDS, ACTION_TYPES, RUN_STATUSES } = require('../constants/automation');

// Workflows of the automation engine (Phase 6): the trigger, conditions and steps are checked
// field by field for their type, so the engine only ever sees settings it understands.
const text = (max) => Joi.string().trim().max(max).allow('');
const sources = Joi.array().items(Joi.string().valid(...LEAD_SOURCES)).max(LEAD_SOURCES.length).unique();
const leadStages = Joi.array().items(Joi.string().valid(...LEAD_STAGES)).max(LEAD_STAGES.length).unique();

const TRIGGER_PARAMS = {
  'lead.created': Joi.object({ sources }),
  'message.received': Joi.object({ keywords: Joi.array().items(Joi.string().trim().min(1).max(60)).max(20) }),
  'lead.stage_changed': Joi.object({ toStages: leadStages, fromStages: leadStages }),
  'lead.no_reply': Joi.object({ hours: Joi.number().integer().min(1).max(720).default(24) }),
  'quotation.not_accepted': Joi.object({ days: Joi.number().integer().min(1).max(90).default(3) }),
  'order.stage_changed': Joi.object({ toStages: Joi.array().items(Joi.string().valid(...ORDER_STAGES)).max(ORDER_STAGES.length).unique() }),
  'payment.received': Joi.object({}),
  'task.overdue': Joi.object({}),
};

const variableSpec = Joi.string().trim().max(205);
const variables = Joi.object({
  header: Joi.object().pattern(/^[A-Za-z0-9_]{1,60}$/, variableSpec),
  body: Joi.object().pattern(/^[A-Za-z0-9_]{1,60}$/, variableSpec),
  buttons: Joi.object().pattern(/^\d{1,2}$/, variableSpec),
});
// Labels make messages like "Step 2 (WhatsApp template): Template is required".
const tagText = Joi.string().trim().min(1).max(50).required().label('Tag');
const STEP_PARAMS = {
  'whatsapp.text': Joi.object({ text: Joi.string().trim().min(1).max(4096).required().label('Message') }),
  'whatsapp.template': Joi.object({ templateId: objectId.required().label('Template'), variables: variables.default({}) }),
  assign: Joi.object({ memberId: objectId.required().label('Person') }),
  'tag.add': Joi.object({ tag: tagText }),
  'tag.remove': Joi.object({ tag: tagText }),
  'stage.change': Joi.object({
    stage: Joi.string().valid(...LEAD_STAGES).required().label('Stage'),
    lostReason: Joi.when('stage', { is: 'Lost', then: Joi.string().trim().min(1).max(500).required(), otherwise: text(500) }).label('Reason for losing'),
  }),
  'task.create': Joi.object({
    title: Joi.string().trim().min(1).max(300).required().label('Task title'),
    description: text(2000),
    dueInDays: Joi.number().integer().min(0).max(365).default(1),
    assignTo: Joi.alternatives(Joi.string().valid('owner'), objectId).default('owner'),
    priority: Joi.string().valid(...TASK_PRIORITIES).default('Medium'),
  }),
  'agent.notify': Joi.object({
    to: Joi.alternatives(Joi.string().valid('owner', 'managers'), objectId).default('owner'),
    message: Joi.string().trim().min(1).max(500).required().label('Message'),
  }),
  wait: Joi.object({ amount: Joi.number().integer().min(1).max(999).required().label('Wait time'), unit: Joi.string().valid('minutes', 'hours', 'days').default('hours') })
    .custom((value, helpers) => (value.amount * { minutes: 1, hours: 60, days: 1440 }[value.unit] <= 90 * 1440 ? value : helpers.message('A wait can be at most 90 days'))),
  'webhook.call': Joi.object({ url: Joi.string().trim().max(500).uri({ scheme: ['https'] }).required().label('Webhook address').messages({ 'string.uriCustomScheme': 'Webhook addresses must start with https://' }) }),
};

const STEP_NAMES = {
  'whatsapp.text': 'WhatsApp message', 'whatsapp.template': 'WhatsApp template', assign: 'Give the lead', 'tag.add': 'Add tag', 'tag.remove': 'Remove tag',
  'stage.change': 'Move stage', 'task.create': 'Create task', 'agent.notify': 'Notify', wait: 'Wait', 'webhook.call': 'Webhook',
};

// Validates `params` with the schema of the item's type (and gives back the cleaned value).
const byType = (schemas, what) => (value, helpers) => {
  const { error, value: params } = schemas[value.type].validate(value.params || {}, { abortEarly: true, stripUnknown: true });
  if (!error) return { ...value, params };
  const where = what === 'Step' ? `Step ${Number(helpers.state.path.at(-1)) + 1} (${STEP_NAMES[value.type]})` : 'Trigger';
  // Joi reads {…} in a message as a template: keep the text literal.
  return helpers.message(`${where}: ${error.message.replace(/"/g, '').replace(/[{}]/g, '')}`);
};

const trigger = Joi.object({ type: Joi.string().valid(...TRIGGER_TYPES).required(), params: Joi.object().unknown(true).default({}) }).custom(byType(TRIGGER_PARAMS, 'Trigger'));
const step = Joi.object({ type: Joi.string().valid(...ACTION_TYPES).required(), params: Joi.object().unknown(true).default({}) }).custom(byType(STEP_PARAMS, 'Step'));

const conditionValue = {
  source: sources.min(1).required(),
  stage: leadStages.min(1).required(),
  tag: Joi.string().trim().min(1).max(50).required(),
  owner: Joi.when('op', { is: Joi.valid('is', 'isNot'), then: objectId.required(), otherwise: Joi.any().strip() }),
  businessHours: Joi.any().strip(),
};
const condition = Joi.object({ field: Joi.string().valid(...Object.keys(CONDITION_FIELDS)).required(), op: Joi.string().required(), value: Joi.any() })
  .custom((value, helpers) => {
    if (!CONDITION_FIELDS[value.field].ops.includes(value.op)) return helpers.message(`"${value.op}" does not go with ${value.field}`);
    const { error, value: checked } = Joi.object({ op: Joi.string(), value: conditionValue[value.field] }).validate({ op: value.op, value: value.value });
    if (error) return helpers.message(`Condition on ${value.field}: ${error.message.replace(/"/g, '')}`);
    return { field: value.field, op: value.op, ...(checked.value !== undefined && { value: checked.value }) };
  });

const fields = {
  name: Joi.string().trim().min(1).max(200),
  status: Joi.string().valid(...AUTOMATION_STATUSES),
  ownerId: objectId.allow(null),
  trigger,
  conditions: Joi.array().items(condition).max(10),
  steps: Joi.array().items(step).min(1).max(20),
};

module.exports = {
  workflowCreate: Joi.object({ ...fields, name: fields.name.required(), trigger: trigger.required(), steps: fields.steps.required() }),
  workflowPatch: Joi.object(fields).min(1),
  workflowList: Joi.object({ ...paginationQuery, q: Joi.string().trim().max(100).allow(''), status: Joi.string().valid(...AUTOMATION_STATUSES), ownerId: objectId, sort: Joi.string().max(40) }),
  workflowRun: Joi.object({ leadId: objectId.required() }),
  runList: Joi.object({ ...paginationQuery, workflowId: objectId, leadId: objectId, status: Joi.string().valid(...RUN_STATUSES) }),
  notificationList: Joi.object({ unread: Joi.boolean().default(false), limit: Joi.number().integer().min(1).max(50).default(20) }),
};
