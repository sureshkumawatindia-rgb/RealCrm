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
const { TRIGGERS, TRIGGER_TYPES, CONDITION_FIELDS, ACTIONS, ACTION_TYPES, RUN_STATUSES, SEQUENCE_STEP_TYPES, WORKFLOW_RECIPES } = require('../constants/automation');
const Conversation = require('../models/Conversation');
const automationSchemas = require('../validators/automation');
const { loadContext } = require('./automation/context');
const { serviceWindow } = require('./conversationService');
const { createOwnedRecordService } = require('./ownedRecordService');
const { visibilityFilter } = require('./access');
const templateService = require('./templateService');
const leadService = require('./leadService');
const engine = require('./automation/engine');
const { VARIABLE_VALUES, fill, resolveVariables } = require('./automation/actions');
const planService = require('./planService');

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

// field: where the params sit in the request ("steps.2.params"), or "" at the top (broadcasts).
async function checkTemplateStep(req, params, field = '') {
  const at = (name) => (field ? `${field}.${name}` : name);
  const template = await MessageTemplate.findOne({ _id: params.templateId, organizationId: req.tenant.organizationId });
  if (!template) throw invalid(at('templateId'), 'Pick one of your WhatsApp templates.', 'INVALID_TEMPLATE');
  const shape = templateService.shapeOf(template);
  if (!shape.sendable) throw invalid(at('templateId'), `"${template.name}" cannot be sent: ${shape.notSendableReason}`, 'TEMPLATE_NOT_SENDABLE');
  const needed = [
    ...(shape.header?.variables || []).map((name) => ['header', name]),
    ...shape.body.variables.map((name) => ['body', name]),
    ...shape.buttons.filter((b) => b.variables.length).map((b) => ['buttons', String(b.index)]),
  ];
  for (const [part, name] of needed) {
    const spec = params.variables?.[part]?.[name];
    if (!spec || !(VARIABLE_VALUES.includes(spec) || /^text:.{1,200}$/s.test(spec))) {
      throw invalid(at(`variables.${part}.${name}`), `Choose what fills {{${name}}} in "${template.name}".`, 'VARIABLE_REQUIRED');
    }
  }
}

// Each check throws its problem (a 400 with the field). conditionIndexes/stepIndexes: only those
// (the builder skips items whose settings are already wrong).
function referenceChecks(req, { conditions = [], steps = [] }, { conditionIndexes = null, stepIndexes = null } = {}) {
  const checks = [];
  for (const [index, condition] of conditions.entries()) {
    if (conditionIndexes && !conditionIndexes.has(index)) continue;
    if (condition.field === 'owner' && ['is', 'isNot'].includes(condition.op)) checks.push(() => activeMember(req, condition.value, `conditions.${index}.value`));
  }
  for (const [index, step] of steps.entries()) {
    if (stepIndexes && !stepIndexes.has(index)) continue;
    const field = `steps.${index}.params`;
    const params = step.params || {};
    if (step.type === 'whatsapp.template') checks.push(() => checkTemplateStep(req, params, field));
    if (step.type === 'assign') {
      checks.push(async () => {
        const member = await activeMember(req, params.memberId, `${field}.memberId`);
        if (!isManager(member) && !member.modules?.some((m) => m === 'leads' || m === 'deals')) {
          throw invalid(`${field}.memberId`, 'This person cannot open Leads, so leads cannot be given to them.', 'MEMBER_NO_LEADS');
        }
      });
    }
    if (step.type === 'task.create' && params.assignTo !== 'owner') checks.push(() => activeMember(req, params.assignTo, `${field}.assignTo`));
    if (step.type === 'agent.notify' && !['owner', 'managers'].includes(params.to)) checks.push(() => activeMember(req, params.to, `${field}.to`));
    if (step.type === 'webhook.call') {
      checks.push(async () => {
        try {
          await assertPublicHttps(params.url);
        } catch (error) {
          throw invalid(`${field}.url`, error.message, 'WEBHOOK_URL');
        }
      });
    }
    if (step.type === 'sequence.enroll') {
      checks.push(async () => {
        if (!(await Sequence.exists({ _id: params.sequenceId, organizationId: req.tenant.organizationId, deletedAt: null }))) throw invalid(`${field}.sequenceId`, 'Pick one of your sequences.', 'INVALID_SEQUENCE');
      });
    }
  }
  return checks;
}

async function checkReferences(req, draft) {
  for (const check of referenceChecks(req, draft)) await check();
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
// Workflows come with the Growth plan and above (D48); follow-up sequences, the FAQ bot and
// auto-replies are in every plan.
async function create(req, body) {
  await planService.assertFeature(req.tenant.organizationId, 'advancedAutomation');
  await checkReferences(req, body);
  return base.create(req, body);
}

async function update(req, id, body) {
  const workflow = await base.findVisible(req, id);
  if (body.status === 'Active' && workflow.status !== 'Active') await planService.assertFeature(req.tenant.organizationId, 'advancedAutomation');
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
  await planService.assertFeature(req.tenant.organizationId, 'advancedAutomation');
  const lead = await leadService.findVisible(req, leadId);
  const run = await engine.runByHand(queue, workflow, { leadId: lead._id, startedBy: req.user.name });
  await audit(req, { action: 'workflow.run', entityType: 'Workflow', entityId: workflow._id, changes: { leadId: String(lead._id), runId: String(run._id) } });
  return serializeRun(run);
}

// --- the builder (Phase 7A, D86) ------------------------------------------------------------
// card: where the builder shows a problem (trigger, condition, step, workflow); index: which one.
function placeOf(path) {
  const [head, index] = String(path).split('.');
  const card = { trigger: 'trigger', conditions: 'condition', steps: 'step' }[head] || 'workflow';
  return { card, index: card === 'condition' || card === 'step' ? Number(index) : null };
}
const problem = (path, code, message, extra = {}) => ({ path, ...placeOf(path), code, level: 'error', message, ...extra });
const warning = (path, code, message) => ({ ...problem(path, code, message), level: 'warning' });
const clean = (message) => String(message).replace(/"/g, '');

// Joi's details for one settings object → problems at "<base>.<key>" (field: the key, for a label).
function paramProblems(base, schema, params) {
  const { error } = schema.validate(params || {}, { abortEarly: false, stripUnknown: true });
  return (error?.details || []).map((detail) => {
    const key = detail.path.join('.');
    const code = ['any.required', 'string.empty'].includes(detail.type) ? 'REQUIRED' : 'INVALID';
    return problem(key ? `${base}.${key}` : base, code, clean(detail.message), { field: detail.path[0] ?? null });
  });
}

const DELAY_MINUTES = { 'lead.no_reply': (p) => (p.hours || 24) * 60, 'quotation.not_accepted': (p) => (p.days || 3) * 1440, 'payment.overdue': (p) => (p.days || 7) * 1440 };
const ORDER_TRIGGERS = ['order.stage_changed', 'payment.received', 'payment.overdue'];
const minutesOf = ({ amount = 1, unit = 'hours' }) => Number(amount) * ({ minutes: 1, hours: 60, days: 1440 }[unit] || 60);

// Every problem of a draft at once, with its card; warnings for what saves but will not work well.
async function check(req, draft = {}) {
  const problems = [];
  if (draft.name !== undefined && !String(draft.name || '').trim()) problems.push(problem('name', 'REQUIRED', 'Give the workflow a name.', { field: 'name' }));
  const trigger = draft.trigger || {};
  let triggerOk = false;
  if (!trigger.type) problems.push(problem('trigger', 'REQUIRED', 'Choose what starts the workflow.'));
  else if (!TRIGGER_TYPES.includes(trigger.type)) problems.push(problem('trigger', 'UNSUPPORTED', `"${String(trigger.type).slice(0, 60)}" is not something that can start a workflow.`));
  else {
    const found = paramProblems('trigger.params', automationSchemas.TRIGGER_PARAMS[trigger.type], trigger.params);
    problems.push(...found);
    triggerOk = !found.length;
  }

  const conditions = Array.isArray(draft.conditions) ? draft.conditions : [];
  if (conditions.length > 10) problems.push(problem('conditions', 'TOO_MANY', 'At most 10 conditions.'));
  const goodConditions = new Set();
  conditions.slice(0, 10).forEach((condition, index) => {
    const { error } = automationSchemas.conditionSchema.validate(condition);
    if (error) problems.push(problem(`conditions.${index}`, 'INVALID', clean(error.message)));
    else goodConditions.add(index);
  });

  const steps = Array.isArray(draft.steps) ? draft.steps : [];
  if (!steps.length) problems.push(problem('steps', 'STEPS_REQUIRED', 'Add at least one step.'));
  if (steps.length > 20) problems.push(problem('steps', 'TOO_MANY', 'At most 20 steps.'));
  const goodSteps = new Set();
  steps.slice(0, 20).forEach((step, index) => {
    if (!ACTION_TYPES.includes(step?.type)) {
      problems.push(problem(`steps.${index}`, 'UNSUPPORTED', `Step ${index + 1}: "${String(step?.type || '').slice(0, 60)}" is not a step the CRM can do.`));
      return;
    }
    const found = paramProblems(`steps.${index}.params`, automationSchemas.STEP_PARAMS[step.type], step.params);
    problems.push(...found);
    if (!found.length) goodSteps.add(index);
  });

  // The people, templates, sequences and addresses of the items whose settings are right.
  const validated = (list, schemaOf) => list.map((item) => {
    const { value } = schemaOf(item).validate(item?.params || {}, { stripUnknown: true });
    return { ...item, params: value };
  });
  const checks = referenceChecks(req, {
    conditions,
    steps: validated(steps.slice(0, 20), (step) => automationSchemas.STEP_PARAMS[step?.type] || automationSchemas.STEP_PARAMS['payment.link']),
  }, { conditionIndexes: goodConditions, stepIndexes: goodSteps });
  for (const run of checks) {
    try {
      await run();
    } catch (error) {
      const detail = error.errors?.[0];
      if (!detail) throw error;
      problems.push(problem(detail.field, detail.code || 'INVALID', detail.message));
    }
  }

  // Warnings.
  if (steps.length && steps.at(-1)?.type === 'wait') problems.push(warning(`steps.${steps.length - 1}`, 'WAIT_LAST', 'A wait at the end does nothing: add a step after it, or remove it.'));
  let late = triggerOk && DELAY_MINUTES[trigger.type] ? DELAY_MINUTES[trigger.type](trigger.params || {}) : 0;
  steps.slice(0, 20).forEach((step, index) => {
    if (step?.type === 'wait' && goodSteps.has(index)) late += minutesOf(step.params || {});
    if (step?.type === 'whatsapp.text' && late >= 24 * 60) {
      problems.push(warning(`steps.${index}`, 'OUTSIDE_WINDOW', 'This message will probably go more than 24 hours after the customer last wrote, when WhatsApp allows only templates. Use a WhatsApp template step.'));
    }
    if (step?.type === 'payment.link' && triggerOk && !ORDER_TRIGGERS.includes(trigger.type)) {
      problems.push(warning(`steps.${index}`, 'NEEDS_ORDER', 'The payment link needs an order: this trigger is not about an order, so the step will be skipped.'));
    }
  });
  return { ok: !problems.some((p) => p.level === 'error'), problems };
}

// What the workflow would do for one lead, as if its trigger fired now. Nothing is sent, saved or
// started: the engine's own condition check and placeholder filling are used on a copy.
const DAY_MS = 24 * 60 * 60 * 1000;
const istDate = (date) => new Date(date.getTime() + 330 * 60000).toISOString().slice(0, 10);

async function preview(req, { draft, leadId }) {
  const result = await check(req, draft);
  const errors = result.problems.filter((p) => p.level === 'error');
  if (errors.length) throw httpError(400, 'VALIDATION_ERROR', `The workflow has ${errors.length === 1 ? 'a problem' : `${errors.length} problems`}: ${errors[0].message}`, errors.map((p) => ({ field: p.path, code: p.code, message: p.message })));
  const { value } = automationSchemas.workflowDraft.validate(draft, { stripUnknown: true });
  const lead = await leadService.findVisible(req, leadId);
  const organizationId = req.tenant.organizationId;
  const loaded = await loadContext({ organizationId, subject: { leadId: lead._id } });
  // Plain copies: steps change them as the run would, so later steps and conditions see it.
  const ctx = { ...loaded, lead: loaded.lead?.toObject(), contact: loaded.contact ? { ...loaded.contact.toObject(), tags: [...(loaded.contact.tags || [])] } : null };

  const matches = {
    'lead.created': () => engine.triggerMatches(value.trigger, { source: ctx.lead.source }),
    'lead.stage_changed': () => (value.trigger.params?.toStages?.length ? value.trigger.params.toStages.includes(ctx.lead.stage) : null),
  };
  const ownerNames = new Map();
  const nameOf = async (memberId) => {
    if (!memberId) return '';
    const key = String(memberId);
    if (!ownerNames.has(key)) {
      const member = await OrganizationMember.findOne({ _id: memberId, organizationId }).populate('userId', 'name');
      ownerNames.set(key, member?.displayName || member?.userId?.name || '');
    }
    return ownerNames.get(key);
  };
  const actual = async (condition) => {
    if (condition.field === 'source' || condition.field === 'stage') return ctx.lead?.[condition.field] || '';
    if (condition.field === 'tag') return (ctx.contact?.tags || []).join(', ');
    if (condition.field === 'owner') return nameOf(ctx.lead?.ownerId);
    return '';
  };
  const conditions = [];
  for (const [index, condition] of value.conditions.entries()) {
    conditions.push({ index, field: condition.field, op: condition.op, value: condition.value ?? null, passed: engine.conditionsMatch([condition], ctx), actual: await actual(condition) });
  }

  const conversation = ctx.contact ? await Conversation.findOne({ organizationId, contactId: ctx.contact._id }).sort({ lastMessageAt: -1, updatedAt: -1 }) : null;
  const phone = ctx.contact?.phoneE164 || '';
  let at = new Date();
  const steps = [];
  for (const [index, step] of value.steps.entries()) {
    const p = step.params || {};
    const out = { index, type: step.type, status: 'do', reason: null, at: at.toISOString(), facts: {} };
    const skip = (reason) => Object.assign(out, { status: 'skip', reason });
    switch (step.type) {
      case 'whatsapp.text':
        out.facts = { text: fill(p.text, ctx).trim(), to: phone };
        if (!phone) skip('NO_PHONE');
        else if (!conversation) skip('NO_CHAT');
        else if (!serviceWindow(conversation, at.getTime()).open) skip('OUTSIDE_WINDOW');
        break;
      case 'whatsapp.template': {
        const template = await MessageTemplate.findOne({ _id: p.templateId, organizationId });
        const variables = resolveVariables(p.variables, ctx);
        out.facts = { template: template?.name || '', language: template?.language || '', variables, to: phone };
        const missing = Object.values(variables).flatMap((values) => Object.entries(values).filter(([, v]) => !String(v).trim()).map(([name]) => name));
        if (!phone) skip('NO_PHONE');
        else if (template?.category === 'MARKETING' && ctx.contact?.consent?.marketing === 'opted_out') skip('OPTED_OUT');
        else if (missing.length) Object.assign(skip('MISSING_VALUE').facts, { missing });
        break;
      }
      case 'assign':
        out.facts = { member: await nameOf(p.memberId) };
        if (String(ctx.lead.ownerId || '') === String(p.memberId)) skip('ALREADY');
        else ctx.lead.ownerId = p.memberId;
        break;
      case 'tag.add':
      case 'tag.remove': {
        const has = (ctx.contact?.tags || []).some((t) => t.toLowerCase() === p.tag.toLowerCase());
        out.facts = { tag: p.tag };
        if (!ctx.contact) skip('NO_CUSTOMER');
        else if (step.type === 'tag.add' ? has : !has) skip('ALREADY');
        else ctx.contact.tags = step.type === 'tag.add' ? [...ctx.contact.tags, p.tag] : ctx.contact.tags.filter((t) => t.toLowerCase() !== p.tag.toLowerCase());
        break;
      }
      case 'stage.change':
        out.facts = { from: ctx.lead.stage, to: p.stage, deal: ctx.lead.title };
        if (ctx.lead.stage === p.stage) skip('ALREADY');
        else ctx.lead.stage = p.stage;
        break;
      case 'task.create':
        out.facts = { title: fill(p.title, ctx).trim(), due: istDate(new Date(at.getTime() + (p.dueInDays || 0) * DAY_MS)), assignee: p.assignTo === 'owner' ? (await nameOf(ctx.lead.ownerId)) || 'owner' : await nameOf(p.assignTo), priority: p.priority };
        break;
      case 'agent.notify':
        out.facts = { to: p.to === 'owner' || p.to === 'managers' ? p.to : await nameOf(p.to), message: fill(p.message, ctx).trim() };
        if (p.to === 'owner') out.facts.ownerName = await nameOf(ctx.lead.ownerId);
        break;
      case 'wait':
        at = new Date(at.getTime() + minutesOf(p) * 60000);
        Object.assign(out, { status: 'wait', facts: { amount: p.amount, unit: p.unit, until: at.toISOString() } });
        break;
      case 'webhook.call':
        out.facts = { host: new URL(p.url).host };
        break;
      case 'sequence.enroll': {
        const sequence = await Sequence.findOne({ _id: p.sequenceId, organizationId }).select('name');
        out.facts = { sequence: sequence?.name || '' };
        break;
      }
      case 'payment.link':
        skip('NO_ORDER');
        break;
      default:
        break;
    }
    steps.push(out);
  }
  return {
    lead: { id: lead._id, title: lead.title, stage: lead.stage, contactName: ctx.contact?.name || '' },
    trigger: { type: value.trigger.type, matchesLead: matches[value.trigger.type] ? matches[value.trigger.type]() : null },
    conditions,
    wouldRun: conditions.every((c) => c.passed),
    steps,
    warnings: result.problems.filter((p) => p.level === 'warning'),
  };
}

const recipes = () => WORKFLOW_RECIPES.map((recipe) => JSON.parse(JSON.stringify(recipe)));

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
      'order.number', 'order.stage', 'order.total', 'order.paid', 'order.due', 'quotation.number', 'quotation.total', 'task.title', 'task.due', 'message.text'],
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
  checkTemplateStep,
  check,
  preview,
  recipes,
  serializeWorkflow,
  serializeRun,
};
