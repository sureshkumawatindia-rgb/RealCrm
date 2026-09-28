const mongoose = require('mongoose');
const Workflow = require('../models/Workflow');
const Sequence = require('../models/Sequence');
const Task = require('../models/Task');
const OrganizationMember = require('../models/OrganizationMember');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { indiaDate } = require('../utils/dates');
const { createOwnedRecordService } = require('./ownedRecordService');
const { serializeTask } = require('./taskService');

// Workflows and sequences are automation settings (Sales Automation page). Pressing Run Now or
// Enroll creates the tasks here on the server; email, notifications and status changes are not
// sent yet (the automation engine arrives in Phase 6), and the answer says so.
const MODULES = ['automation'];

function serializeWorkflow(workflow) {
  return {
    id: workflow._id,
    name: workflow.name,
    status: workflow.status,
    trigger: workflow.trigger,
    actions: workflow.actions.map(({ type, detail }) => ({ type, detail })),
    ownerId: workflow.ownerId || null,
    runsCount: workflow.runsCount,
    lastRunAt: workflow.lastRunAt || null,
    createdByMemberId: workflow.createdByMemberId || null,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

function serializeSequence(sequence) {
  return {
    id: sequence._id,
    name: sequence.name,
    targetType: sequence.targetType,
    status: sequence.status,
    steps: sequence.steps.map(({ day, type, note }) => ({ day, type, note })),
    ownerId: sequence.ownerId || null,
    enrolledCount: sequence.enrolledCount,
    lastEnrolledAt: sequence.lastEnrolledAt || null,
    createdByMemberId: sequence.createdByMemberId || null,
    createdAt: sequence.createdAt,
    updatedAt: sequence.updatedAt,
  };
}

const common = {
  modules: MODULES,
  searchFields: ['name'],
  sorts: ['createdAt', 'updatedAt', 'name', 'status'],
  defaultSort: { createdAt: -1 },
  filters: (query) => ({
    ...(query.status && { status: query.status }),
    ...(query.ownerId && { ownerId: query.ownerId }),
  }),
};

const workflows = createOwnedRecordService({
  ...common,
  Model: Workflow,
  entityType: 'Workflow',
  label: 'Workflow',
  fields: ['name', 'status', 'trigger', 'actions'],
  searchFields: ['name', 'trigger'],
  serialize: serializeWorkflow,
});

const sequences = createOwnedRecordService({
  ...common,
  Model: Sequence,
  entityType: 'Sequence',
  label: 'Sequence',
  fields: ['name', 'targetType', 'status', 'steps'],
  searchFields: ['name', 'targetType'],
  serialize: serializeSequence,
});

function assertActive(record, label) {
  if (record.status !== 'Active') throw httpError(409, 'NOT_ACTIVE', `Only an active ${label} can run. Set it to Active first.`);
}

// Tasks go to the automation's owner while they are still an active member.
async function activeOwner(record) {
  if (!record.ownerId) return undefined;
  const active = await OrganizationMember.exists({ _id: record.ownerId, organizationId: record.organizationId, status: 'active' });
  return active ? record.ownerId : undefined;
}

// Creates the tasks and counts the run in one transaction, so a failure leaves neither behind.
async function createTasksAndCount(req, Model, record, taskInputs, counterUpdate) {
  let tasks = [];
  let updated;
  await mongoose.connection.transaction(async (session) => {
    tasks = [];
    for (const input of taskInputs) {
      const [task] = await Task.create([{
        organizationId: req.tenant.organizationId,
        ...input,
        priority: 'Medium',
        status: 'To Do',
        origin: 'automation',
        createdById: req.user._id,
        createdByMemberId: req.member._id,
      }], { session });
      tasks.push(task);
    }
    updated = await Model.findOneAndUpdate(
      { _id: record._id, organizationId: req.tenant.organizationId },
      counterUpdate,
      { session, returnDocument: 'after' },
    );
  });
  return { tasks, updated };
}

async function runWorkflow(req, id) {
  const workflow = await workflows.findVisible(req, id);
  assertActive(workflow, 'workflow');
  const assigneeId = await activeOwner(workflow);
  const taskInputs = workflow.actions
    .filter((action) => action.type === 'Create Task')
    .map((action) => ({
      title: (action.detail || `${workflow.name} — follow up`).slice(0, 300),
      description: `Auto-created by workflow "${workflow.name}"`,
      assigneeId,
      dueDate: indiaDate(2),
    }));
  const { tasks, updated } = await createTasksAndCount(req, Workflow, workflow, taskInputs, { $inc: { runsCount: 1 }, $set: { lastRunAt: new Date() } });
  await audit(req, { action: 'workflow.run', entityType: 'Workflow', entityId: workflow._id, changes: { tasksCreated: tasks.length } });
  return {
    workflow: serializeWorkflow(updated),
    tasks: tasks.map(serializeTask),
    // Configured actions that were not carried out (no email, notification or status change yet).
    simulated: [...new Set(workflow.actions.filter((action) => action.type !== 'Create Task').map((action) => action.type))],
  };
}

// "Enroll one": schedules the first Task or Call step as a task and counts the enrollment.
async function enrollSequence(req, id) {
  const sequence = await sequences.findVisible(req, id);
  assertActive(sequence, 'sequence');
  const first = [...sequence.steps].sort((a, b) => a.day - b.day).find((step) => step.type === 'Task' || step.type === 'Call');
  const taskInputs = first
    ? [{
      title: (first.note || `${sequence.name} — Day ${first.day} touchpoint`).slice(0, 300),
      description: `Auto-created by sequence "${sequence.name}"`,
      assigneeId: await activeOwner(sequence),
      dueDate: indiaDate(first.day),
    }]
    : [];
  const { tasks, updated } = await createTasksAndCount(req, Sequence, sequence, taskInputs, { $inc: { enrolledCount: 1 }, $set: { lastEnrolledAt: new Date() } });
  await audit(req, { action: 'sequence.enrolled', entityType: 'Sequence', entityId: sequence._id, changes: { tasksCreated: tasks.length } });
  return {
    sequence: serializeSequence(updated),
    task: tasks[0] ? serializeTask(tasks[0]) : null,
    firstTaskDay: first ? first.day : null,
    simulated: [...new Set(sequence.steps.filter((step) => step !== first && step.type !== 'Wait').map((step) => step.type))],
  };
}

module.exports = {
  MODULES,
  workflows,
  sequences,
  runWorkflow,
  enrollSequence,
  serializeWorkflow,
  serializeSequence,
};
