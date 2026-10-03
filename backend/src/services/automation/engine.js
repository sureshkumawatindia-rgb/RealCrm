const AutomationRun = require('../../models/AutomationRun');
const Contact = require('../../models/Contact');
const Conversation = require('../../models/Conversation');
const Lead = require('../../models/Lead');
const Order = require('../../models/Order');
const Organization = require('../../models/Organization');
const OrganizationMember = require('../../models/OrganizationMember');
const Quotation = require('../../models/Quotation');
const Task = require('../../models/Task');
const Workflow = require('../../models/Workflow');
const bus = require('../../realtime/bus');
const logger = require('../../config/logger');
const { indiaDate } = require('../../utils/dates');
const { businessHoursOf, isOpen } = require('../../utils/businessHours');
const { OPEN_STAGES } = require('../../constants/crm');
const { TRIGGERS, MAX_CHAIN } = require('../../constants/automation');
const { ACTIONS } = require('./actions');

// The automation engine (Phase 6). Business events (services call automation/events.emit)
// become "automation.event" jobs; each Active workflow whose trigger and conditions fit starts
// an AutomationRun, whose steps run in "automation.step" jobs — a wait step schedules the next
// job for later. Time-based triggers (no reply, quote not accepted, task overdue) are found by
// "automation.scan" every 10 minutes; a dedupe key makes each one start only once per thing.
const JOBS = { EVENT: 'automation.event', STEP: 'automation.step', SCAN: 'automation.scan' };
const SCAN_EVERY_MS = 10 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const TIME_TRIGGERS = Object.entries(TRIGGERS).filter(([, t]) => t.kind === 'time').map(([type]) => type);
const norm = (value) => String(value || '').trim().toLowerCase();
const list = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);

// --- matching ---------------------------------------------------------------------------
function triggerMatches(trigger, event) {
  const p = trigger.params || {};
  switch (trigger.type) {
    case 'lead.created': return !p.sources?.length || p.sources.includes(event.source);
    case 'message.received': {
      if (!p.keywords?.length) return true;
      const text = norm(event.text);
      return p.keywords.some((keyword) => norm(keyword) && text.includes(norm(keyword)));
    }
    case 'lead.stage_changed':
      return (!p.toStages?.length || p.toStages.includes(event.to)) && (!p.fromStages?.length || p.fromStages.includes(event.from));
    case 'order.stage_changed': return !p.toStages?.length || p.toStages.includes(event.to);
    default: return true;
  }
}

function conditionsMatch(conditions = [], ctx) {
  return conditions.every((condition) => {
    const { field, op, value } = condition;
    switch (field) {
      case 'source':
      case 'stage': {
        const current = ctx.lead?.[field];
        const inList = Boolean(current) && list(value).includes(current);
        return op === 'notIn' ? !inList : inList;
      }
      case 'tag': {
        const has = (ctx.contact?.tags || []).map(norm).includes(norm(value));
        return op === 'hasNot' ? !has : has;
      }
      case 'owner': {
        const owner = ctx.lead?.ownerId ? String(ctx.lead.ownerId) : '';
        if (op === 'none') return !owner;
        if (op === 'any') return Boolean(owner);
        return op === 'isNot' ? owner !== String(value) : owner === String(value);
      }
      case 'businessHours': {
        const open = isOpen(businessHoursOf(ctx.organization));
        return op === 'closed' ? !open : open;
      }
      default: return false;
    }
  });
}

// --- context: the records a run is about, loaded fresh -----------------------------------
async function loadContext({ organizationId, subject = {}, event = {} }) {
  const byId = (Model, id) => (id ? Model.findOne({ _id: id, organizationId }) : null);
  const [lead, order, quotation, task, conversation, organization] = await Promise.all([
    byId(Lead, subject.leadId), byId(Order, subject.orderId), byId(Quotation, subject.quotationId), byId(Task, subject.taskId),
    byId(Conversation, subject.conversationId), Organization.findById(organizationId),
  ]);
  const contactId = subject.contactId || lead?.contactId || order?.contactId || quotation?.contactId || conversation?.contactId;
  const contact = contactId ? await Contact.findOne({ _id: contactId, organizationId }) : null;
  const owner = lead?.ownerId ? await OrganizationMember.findById(lead.ownerId).populate('userId', 'name') : null;
  return { organization, lead, contact, order, quotation, task, conversation, event, ownerName: owner?.displayName || owner?.userId?.name || '' };
}

// The newest open lead of a customer (else their newest lead).
async function leadOfContact(organizationId, contactId) {
  if (!contactId) return null;
  return (await Lead.findOne({ organizationId, contactId, stage: { $in: OPEN_STAGES } }).sort({ createdAt: -1 }))
    || Lead.findOne({ organizationId, contactId }).sort({ createdAt: -1 });
}

async function subjectOf(event) {
  const ids = (keys) => Object.fromEntries(keys.filter((key) => event[key]).map((key) => [key, String(event[key])]));
  const subject = ids(['leadId', 'contactId', 'conversationId', 'orderId', 'quotationId', 'taskId']);
  if (!subject.leadId && subject.contactId && event.type === 'message.received') {
    const lead = await leadOfContact(event.organizationId, subject.contactId);
    if (lead) subject.leadId = String(lead._id);
  }
  return subject;
}

function summaryOf(event) {
  const fields = ['source', 'from', 'to', 'orderNumber', 'amountPaise'];
  return { ...Object.fromEntries(fields.filter((f) => event[f] !== undefined).map((f) => [f, event[f]])), ...(event.text && { text: String(event.text).slice(0, 300) }) };
}

// --- runs -------------------------------------------------------------------------------
async function startRun(queue, workflow, { trigger, event = {}, subject, chain = [], dedupeKey, label }) {
  let run;
  try {
    run = await AutomationRun.create({
      organizationId: workflow.organizationId, workflowId: workflow._id, workflowName: workflow.name, trigger, event,
      subject: { ...subject, label: label || '' }, chain, dedupeKey,
    });
  } catch (error) {
    if (error.code === 11000) return null; // already started for this event
    throw error;
  }
  await Workflow.updateOne({ _id: workflow._id }, { $inc: { 'stats.runs': 1 }, $set: { 'stats.lastRunAt': new Date() } });
  await queue.enqueue(JOBS.STEP, { runId: String(run._id) }, { uniqueKey: `run:${run._id}:0`, organizationId: workflow.organizationId, maxAttempts: 4 });
  return run;
}

async function finish(run, status, error = '') {
  run.status = status;
  run.error = String(error || '').slice(0, 1000);
  run.finishedAt = new Date();
  run.nextAt = undefined;
  await run.save();
  if (status === 'done' || status === 'failed') await Workflow.updateOne({ _id: run.workflowId }, { $inc: { [`stats.${status}`]: 1 } });
}

// The request-like object actions use to change records as "the automation".
function systemReq(run, workflow) {
  return {
    tenant: { organizationId: run.organizationId },
    member: { _id: undefined, role: 'owner', modules: [], permissions: [], status: 'active' },
    user: { _id: undefined, name: `Automation "${workflow.name}"` },
    automation: { runId: run._id, chain: [...run.chain.map(String), String(workflow._id)] },
    id: `automation:${run._id}`,
    ip: '',
    get: () => '',
  };
}

const waitMs = ({ amount = 1, unit = 'hours' }) => Number(amount) * ({ minutes: 60 * 1000, hours: HOUR, days: DAY }[unit] || HOUR);
const istTime = (date) => date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

// Runs the steps of one run from where it stopped, until the end or a wait.
async function runSteps(queue, { runId }, job) {
  const run = await AutomationRun.findById(runId);
  if (!run || !['running', 'waiting'].includes(run.status)) return;
  const workflow = await Workflow.findById(run.workflowId);
  if (!workflow || workflow.status !== 'Active') return finish(run, 'cancelled', workflow ? 'The workflow was paused before this run finished.' : 'The workflow was removed.');
  if (run.status === 'waiting') {
    const waiting = [...run.steps].reverse().find((s) => s.status === 'waiting');
    if (waiting) waiting.status = 'done';
    run.status = 'running';
    run.nextAt = undefined;
  }
  while (run.stepIndex < workflow.steps.length) {
    const index = run.stepIndex;
    const step = workflow.steps[index];
    if (step.type === 'wait') {
      const nextAt = new Date(Date.now() + waitMs(step.params || {}));
      run.steps.push({ index, type: 'wait', status: 'waiting', detail: `Waiting until ${istTime(nextAt)}` });
      run.stepIndex = index + 1;
      run.status = 'waiting';
      run.nextAt = nextAt;
      await run.save();
      await queue.enqueue(JOBS.STEP, { runId }, { runAt: nextAt, uniqueKey: `run:${runId}:${run.stepIndex}`, organizationId: run.organizationId, maxAttempts: 4 });
      return;
    }
    let result;
    try {
      const ctx = await loadContext({ organizationId: run.organizationId, subject: run.subject, event: run.event });
      result = await ACTIONS[step.type]({ ctx, params: step.params || {}, run, workflow, req: systemReq(run, workflow) });
    } catch (error) {
      const final = Boolean(error.statusCode && error.statusCode < 500);
      if (!final && job && job.attempts < job.maxAttempts) throw error; // the job tries this step again
      run.steps.push({ index, type: step.type, status: 'failed', detail: String(error.message || error).slice(0, 500) });
      logger.warn(`Automation run ${run._id} failed at step ${index} (${step.type}): ${error.message}`);
      return finish(run, 'failed', error.message);
    }
    run.steps.push({ index, type: step.type, status: result?.status || 'done', detail: String(result?.detail || '').slice(0, 500) });
    run.stepIndex = index + 1;
    await run.save();
  }
  return finish(run, 'done');
}

// --- events ------------------------------------------------------------------------------
async function handleEvent(queue, event) {
  const workflows = await Workflow.find({ organizationId: event.organizationId, status: 'Active', 'trigger.type': event.type });
  if (!workflows.length) return;
  const chain = (event.chain || []).map(String);
  if (chain.length >= MAX_CHAIN) {
    logger.warn(`Automation chain too long for ${event.type} (${chain.length}); not started`);
    return;
  }
  const subject = await subjectOf(event);
  const ctx = await loadContext({ organizationId: event.organizationId, subject, event });
  for (const workflow of workflows) {
    if (chain.includes(String(workflow._id))) continue; // no workflow re-triggers itself
    if (!triggerMatches(workflow.trigger, event) || !conditionsMatch(workflow.conditions, ctx)) continue;
    await startRun(queue, workflow, {
      trigger: event.type, event: summaryOf(event), subject, chain, dedupeKey: event.key, label: ctx.contact?.name || ctx.lead?.title || '',
    });
  }
}

// --- time-based triggers -----------------------------------------------------------------
async function candidatesFor(workflow) {
  const organizationId = workflow.organizationId;
  const p = workflow.trigger.params || {};
  const now = Date.now();
  if (workflow.trigger.type === 'lead.no_reply') {
    const hours = Math.min(Math.max(Number(p.hours) || 24, 1), 720);
    const chats = await Conversation.find({
      organizationId, lastMessageDirection: 'out', lastMessageAt: { $lte: new Date(now - hours * HOUR), $gte: new Date(now - hours * HOUR - 7 * DAY) },
    }).limit(200);
    const out = [];
    for (const chat of chats) {
      const lead = await leadOfContact(organizationId, chat.contactId);
      out.push({ key: `noreply:${chat._id}:${chat.lastMessageAt.getTime()}`, subject: { conversationId: String(chat._id), contactId: String(chat.contactId), ...(lead && { leadId: String(lead._id) }) }, event: { hours } });
    }
    return out;
  }
  if (workflow.trigger.type === 'quotation.not_accepted') {
    const days = Math.min(Math.max(Number(p.days) || 3, 1), 90);
    const quotations = await Quotation.find({
      organizationId, status: { $in: ['Sent', 'Viewed'] }, sentAt: { $lte: new Date(now - days * DAY), $gte: new Date(now - days * DAY - 30 * DAY) },
    }).select('_id leadId contactId revision number').limit(200);
    return quotations.map((q) => ({
      key: `quote:${q._id}:${q.revision || 0}`,
      subject: { quotationId: String(q._id), ...(q.leadId && { leadId: String(q.leadId) }), ...(q.contactId && { contactId: String(q.contactId) }) },
      event: { days, quotationNumber: q.number },
    }));
  }
  if (workflow.trigger.type === 'task.overdue') {
    const tasks = await Task.find({ organizationId, status: { $ne: 'Done' }, dueDate: { $lt: indiaDate(0), $gte: indiaDate(-30) } }).limit(200);
    return tasks.map((task) => ({
      key: `task:${task._id}:${task.dueDate}`,
      subject: {
        taskId: String(task._id),
        ...(['Lead', 'Deal'].includes(task.relatedType) && task.relatedId && { leadId: String(task.relatedId) }),
        ...(['Customer', 'Contact'].includes(task.relatedType) && task.relatedId && { contactId: String(task.relatedId) }),
      },
      event: { due: task.dueDate },
    }));
  }
  return [];
}

async function scan(queue) {
  const workflows = await Workflow.find({ status: 'Active', 'trigger.type': { $in: TIME_TRIGGERS } });
  let started = 0;
  for (const workflow of workflows) {
    try {
      for (const candidate of await candidatesFor(workflow)) {
        if (await AutomationRun.exists({ workflowId: workflow._id, dedupeKey: candidate.key })) continue;
        const ctx = await loadContext({ organizationId: workflow.organizationId, subject: candidate.subject, event: candidate.event });
        if (!conditionsMatch(workflow.conditions, ctx)) continue;
        const run = await startRun(queue, workflow, {
          trigger: workflow.trigger.type, event: candidate.event, subject: candidate.subject, dedupeKey: candidate.key,
          label: ctx.contact?.name || ctx.task?.title || ctx.lead?.title || '',
        });
        if (run) started += 1;
      }
    } catch (error) {
      logger.error(`Automation scan of workflow ${workflow._id} failed: ${error.message}`);
    }
  }
  return started;
}

// --- by hand (a test run from the Sales Automation page) ---------------------------------
async function runByHand(queue, workflow, { leadId, startedBy }) {
  const lead = await Lead.findOne({ _id: leadId, organizationId: workflow.organizationId });
  const contact = lead ? await Contact.findById(lead.contactId) : null;
  return startRun(queue, workflow, {
    trigger: 'manual', event: { startedBy }, subject: { leadId: String(lead._id), contactId: String(lead.contactId) }, label: contact?.name || lead.title,
  });
}

let listener = null;
let queueRef = null;
function register(queue) {
  queueRef = queue;
  queue.define(JOBS.EVENT, (event) => handleEvent(queue, event), { maxAttempts: 5 });
  queue.define(JOBS.STEP, (data, job) => runSteps(queue, data, job), { maxAttempts: 4 });
  queue.define(JOBS.SCAN, () => scan(queue), { maxAttempts: 2 });
  queue.every(JOBS.SCAN, SCAN_EVERY_MS).catch((error) => logger.error(`Scheduling ${JOBS.SCAN} failed: ${error.message}`));
  if (listener) bus.off('automation:event', listener);
  listener = (event) => {
    queue.enqueue(JOBS.EVENT, event, { organizationId: event.organizationId })
      .catch((error) => logger.error(`Automation event ${event.type} could not be queued: ${error.message}`));
  };
  bus.on('automation:event', listener);
}
const queue = () => queueRef;

module.exports = { register, queue, JOBS, triggerMatches, conditionsMatch, handleEvent, runSteps, scan, startRun, runByHand, finish, TIME_TRIGGERS };
