const mongoose = require('mongoose');
const Sequence = require('../models/Sequence');
const Task = require('../models/Task');
const OrganizationMember = require('../models/OrganizationMember');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { indiaDate } = require('../utils/dates');
const { createOwnedRecordService } = require('./ownedRecordService');
const { serializeTask } = require('./taskService');

// Sequences (Sales Automation page). Pressing Enroll creates the first task here on the server;
// the other steps are not carried out yet (per-contact sequences arrive in Phase 6B), and the
// answer says so. Workflows run on the automation engine (workflowService, automation/engine).
const MODULES = ['automation'];

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

const sequences = createOwnedRecordService({
  Model: Sequence,
  modules: MODULES,
  entityType: 'Sequence',
  label: 'Sequence',
  fields: ['name', 'targetType', 'status', 'steps'],
  searchFields: ['name', 'targetType'],
  sorts: ['createdAt', 'updatedAt', 'name', 'status'],
  defaultSort: { createdAt: -1 },
  filters: (query) => ({
    ...(query.status && { status: query.status }),
    ...(query.ownerId && { ownerId: query.ownerId }),
  }),
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
  sequences,
  enrollSequence,
  serializeSequence,
};
