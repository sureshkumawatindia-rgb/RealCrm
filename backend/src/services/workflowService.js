const crypto = require('crypto');
const AutomationRun = require('../models/AutomationRun');
const MessageTemplate = require('../models/MessageTemplate');
const OrganizationMember = require('../models/OrganizationMember');
const Sequence = require('../models/Sequence');
const Workflow = require('../models/Workflow');
const queue = require('../jobs/queue');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { toPage, paginationMeta } = require('../utils/pagination');
const { assertPublicHttps } = require('../utils/safeWebhook');
const { isManager } = require('../constants/permissions');
const { LEAD_STAGES, LEAD_SOURCES, ORDER_STAGES } = require('../constants/crm');
const { TRIGGERS, CONDITION_FIELDS, ACTIONS, RUN_STATUSES, SEQUENCE_STEP_TYPES } = require('../constants/automation');
const { createOwnedRecordService } = require('./ownedRecordService');
const { visibilityFilter } = require('./access');
const templateService = require('./templateService');
const leadService = require('./leadService');
const engine = require('./automation/engine');
const { VARIABLE_VALUES } = require('./automation/actions');

// Workflows of the automation engine (Sales Automation page, Phase 6): "when <trigger>, if
// <conditions>, do <steps>". Saving checks what Joi cannot: the people, templates and webhook
// addresses a workflow uses. Runs (one per lead, order … it started for) are read here too.
const MODULES = ['automation'];
const STOPPABLE = ['running', 'waiting'];
const invalid = (field, message, code = 'INVALID') => httpError(400, 'VALIDATION_ERROR', message, [{ field, code, message }]);
const plain = (value) => (value && typeof value.toObject === 'function' ? value.toObject() : value);

function serializeWorkflow(workflow, { withSecret = false } = {}) {
  return {
    id: workflow._id,
    name: workflow.name,
    status: workflow.status,
    trigger: { type: workflow.trigger?.type, params: plain(workflow.trigger?.params) || {} },
    conditions: (workflow.conditions || []).map(({ field, op, value }) => ({ field, op, ...(value !== undefined && { value: plain(value) }) })),
    steps: (workflow.steps || []).map(({ type, params }) => ({ type, params: plain(params) || {} })),
    notes: workflow.notes || [],
    hasWebhook: Boolean(workflow.webhookSecret),
    ...(withSecret && workflow.webhookSecret && { webhookSecret: workflow.webhookSecret }),
    ownerId: workflow.ownerId || null,
    stats: {
      runs: workflow.stats?.runs || 0, done: workflow.stats?.done || 0, failed: workflow.stats?.failed || 0, lastRunAt: workflow.stats?.lastRunAt || null,
    },
    createdByMemberId: workflow.createdByMemberId || null,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

function serializeRun(run) {
  return {
    id: run._id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    trigger: run.trigger,
    event: run.event || {},
    subject: {
      leadId: run.subject?.leadId || null, contactId: run.subject?.contactId || null, conversationId: run.subject?.conversationId || null,
      orderId: run.subject?.orderId || null, quotationId: run.subject?.quotationId || null, taskId: run.subject?.taskId || null, label: run.subject?.label || '',
    },
    status: run.status,
    steps: run.steps.map(({ index, type, status, detail, at }) => ({ index, type, label: ACTIONS[type] || type, status, detail, at })),
    nextAt: run.nextAt || null,
    error: run.error || '',
    createdAt: run.createdAt,
    finishedAt: run.finishedAt || null,
  };
}

const base = createOwnedRecordService({
  Model: Workflow,
  modules: MODULES,
  entityType: 'Workflow',
  label: 'Workflow',
  fields: ['name', 'status', 'trigger', 'conditions', 'steps'],
  searchFields: ['name'],
  sorts: ['createdAt', 'updatedAt', 'name', 'status'],
  defaultSort: { createdAt: -1 },
  filters: (query) => ({ ...(query.status && { status: query.status }), ...(query.ownerId && { ownerId: query.ownerId }) }),
  // A webhook step needs the secret that signs its calls.
  prepare: (record) => {
    if (!record.webhookSecret && record.steps.some((step) => step.type === 'webhook.call')) record.webhookSecret = crypto.randomBytes(24).toString('hex');
  },
  serialize: serializeWorkflow,
});

// --- checks on save ----------------------------------------------------------------------
async function activeMember(req, id, field) {
  const member = await OrganizationMember.findOne({ _id: id, organizationId: req.tenant.organizationId, status: 'active' });
  if (!member) throw invalid(field, 'Pick an active member of your team.', 'INVALID_MEMBER');
  return member;
}

async function checkTemplateStep(req, params, field) {
  const template = await MessageTemplate.findOne({ _id: params.templateId, organizationId: req.tenant.organizationId });
  if (!template) throw invalid(`${field}.templateId`, 'Pick one of your WhatsApp templates.', 'INVALID_TEMPLATE');
  const shape = templateService.shapeOf(template);
  if (!shape.sendable) throw invalid(`${field}.templateId`, `"${template.name}" cannot be sent: ${shape.notSendableReason}`, 'TEMPLATE_NOT_SENDABLE');
  const needed = [
    ...(shape.header?.variables || []).map((name) => ['header', name]),
    ...shape.body.variables.map((name) => ['body', name]),
    ...shape.buttons.filter((b) => b.variables.length).map((b) => ['buttons', String(b.index)]),
  ];
  for (const [part, name] of needed) {
    const spec = params.variables?.[part]?.[name];
    if (!spec || !(VARIABLE_VALUES.includes(spec) || /^text:.{1,200}$/s.test(spec))) {
      throw invalid(`${field}.variables.${part}.${name}`, `Choose what fills {{${name}}} in "${template.name}".`, 'VARIABLE_REQUIRED');
    }
  }
}

async function checkReferences(req, { conditions = [], steps = [] }) {
  for (const [index, condition] of conditions.entries()) {
    if (condition.field === 'owner' && ['is', 'isNot'].includes(condition.op)) await activeMember(req, condition.value, `conditions.${index}.value`);
  }
  for (const [index, step] of steps.entries()) {
    const field = `steps.${index}.params`;
    const params = step.params || {};
    if (step.type === 'whatsapp.template') await checkTemplateStep(req, params, field);
    if (step.type === 'assign') {
      const member = await activeMember(req, params.memberId, `${field}.memberId`);
      if (!isManager(member) && !member.modules?.some((m) => m === 'leads' || m === 'deals')) {
        throw invalid(`${field}.memberId`, 'This person cannot open Leads, so leads cannot be given to them.', 'MEMBER_NO_LEADS');
      }
    }
    if (step.type === 'task.create' && params.assignTo !== 'owner') await activeMember(req, params.assignTo, `${field}.assignTo`);
    if (step.type === 'agent.notify' && !['owner', 'managers'].includes(params.to)) await activeMember(req, params.to, `${field}.to`);
    if (step.type === 'webhook.call') {
      try {
        await assertPublicHttps(params.url);
      } catch (error) {
        throw invalid(`${field}.url`, error.message, 'WEBHOOK_URL');
      }
    }
    if (step.type === 'sequence.enroll' && !(await Sequence.exists({ _id: params.sequenceId, organizationId: req.tenant.organizationId, deletedAt: null }))) {
      throw invalid(`${field}.sequenceId`, 'Pick one of your sequences.', 'INVALID_SEQUENCE');
    }
  }
}

// Pausing or removing a workflow stops its runs that are still going (e.g. inside a wait).
async function stopRuns(workflow, reason) {
  const { modifiedCount } = await AutomationRun.updateMany(
    { workflowId: workflow._id, status: { $in: STOPPABLE } },
    { $set: { status: 'cancelled', error: reason, finishedAt: new Date(), 'steps.$[waiting].status': 'skipped' }, $unset: { nextAt: 1 } },
    { arrayFilters: [{ 'waiting.status': 'waiting' }] },
  );
  return modifiedCount;
}

// --- workflows -----------------------------------------------------------------------------
async function create(req, body) {
  await checkReferences(req, body);
  return base.create(req, body);
}

async function update(req, id, body) {
  const workflow = await base.findVisible(req, id);
  if (['conditions', 'steps', 'status'].some((key) => key in body)) {
    await checkReferences(req, {
      conditions: body.conditions || plain(workflow.conditions),
      steps: body.steps || workflow.steps.map(({ type, params }) => ({ type, params: plain(params) })),
    });
  }
  // e.g. a Phase 2 workflow whose actions had no equivalent (migration 003) has no steps yet.
  if (body.status === 'Active' && !(body.steps || workflow.steps).length) throw invalid('steps', 'Add at least one step before turning this workflow on.', 'STEPS_REQUIRED');
  const wasActive = workflow.status === 'Active';
  const updated = await base.update(req, id, body);
  if (wasActive && updated.status !== 'Active') await stopRuns(workflow, `Stopped: the workflow was set to ${updated.status}.`);
  return updated;
}

async function remove(req, id) {
  const workflow = await base.findVisible(req, id);
  await base.remove(req, id);
  await stopRuns(workflow, 'Stopped: the workflow was deleted.');
}

// Owners and admins see the webhook secret (to check the X-CRM-Signature of calls).
async function get(req, id) {
  return serializeWorkflow(await base.findVisible(req, id), { withSecret: isManager(req.member) });
}

// "Test run": starts the workflow now for one lead, whatever its trigger.
async function runByHand(req, id, { leadId }) {
  const workflow = await base.findVisible(req, id);
  if (workflow.status !== 'Active') throw httpError(409, 'NOT_ACTIVE', 'Only an active workflow can run. Set it to Active first.');
  const lead = await leadService.findVisible(req, leadId);
  const run = await engine.runByHand(queue, workflow, { leadId: lead._id, startedBy: req.user.name });
  await audit(req, { action: 'workflow.run', entityType: 'Workflow', entityId: workflow._id, changes: { leadId: String(lead._id), runId: String(run._id) } });
  return serializeRun(run);
}

// --- runs ----------------------------------------------------------------------------------
// Members who see only their own workflows see only those workflows' runs.
async function runScope(req) {
  const organizationId = req.tenant.organizationId;
  const visibility = visibilityFilter(req, MODULES);
  if (!Object.keys(visibility).length) return { organizationId };
  const own = await Workflow.find({ organizationId, ...visibility }).select('_id');
  return { organizationId, workflowId: { $in: own.map((w) => w._id) } };
}

async function listRuns(req, query) {
  const scope = await runScope(req);
  const filter = {
    ...scope,
    ...(query.workflowId && { workflowId: scope.workflowId ? { $in: scope.workflowId.$in.filter((w) => String(w) === query.workflowId) } : query.workflowId }),
    ...(query.leadId && { 'subject.leadId': query.leadId }),
    ...(query.status && { status: query.status }),
  };
  const page = toPage(query);
  const [items, total] = await Promise.all([
    AutomationRun.find(filter).sort({ createdAt: -1 }).skip(page.skip).limit(page.limit),
    AutomationRun.countDocuments(filter),
  ]);
  return { items: items.map(serializeRun), pagination: paginationMeta(page, total) };
}

async function findRun(req, id) {
  const run = await AutomationRun.findOne({ _id: id, ...(await runScope(req)) });
  if (!run) throw httpError(404, 'NOT_FOUND', 'Run not found');
  return run;
}

async function cancelRun(req, id) {
  const run = await findRun(req, id);
  if (!STOPPABLE.includes(run.status)) throw httpError(409, 'RUN_FINISHED', 'This run has already finished.');
  await engine.finish(run, 'cancelled', `Stopped by ${req.user.name}.`);
  await queue.cancel(`run:${run._id}:${run.stepIndex}`);
  await audit(req, { action: 'automationrun.cancelled', entityType: 'AutomationRun', entityId: run._id });
  return serializeRun(run);
}

// What the workflow builder offers (labels and choices).
function meta() {
  return {
    triggers: Object.entries(TRIGGERS).map(([type, { label, kind }]) => ({ type, label, kind })),
    conditions: Object.entries(CONDITION_FIELDS).map(([field, { label, ops }]) => ({ field, label, ops })),
    actions: Object.entries(ACTIONS).map(([type, label]) => ({ type, label })),
    sequenceSteps: SEQUENCE_STEP_TYPES,
    variableValues: VARIABLE_VALUES,
    placeholders: ['contact.name', 'contact.company', 'contact.city', 'contact.phone', 'lead.title', 'lead.stage', 'lead.source', 'owner.name', 'org.name',
      'order.number', 'order.stage', 'order.total', 'quotation.number', 'quotation.total', 'task.title', 'task.due', 'message.text'],
    leadStages: LEAD_STAGES,
    orderStages: ORDER_STAGES,
    sources: LEAD_SOURCES,
    runStatuses: RUN_STATUSES,
  };
}

module.exports = {
  MODULES,
  list: base.list,
  get,
  create,
  update,
  remove,
  findVisible: base.findVisible,
  runByHand,
  listRuns,
  getRun: async (req, id) => serializeRun(await findRun(req, id)),
  cancelRun,
  meta,
  checkReferences,
  serializeWorkflow,
  serializeRun,
};
