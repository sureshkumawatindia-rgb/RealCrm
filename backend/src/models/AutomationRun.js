const mongoose = require('mongoose');
const { RUN_STATUSES } = require('../constants/automation');

// One execution of a workflow for one subject (Phase 6): what started it, and a log line per
// step. A run waiting on a "wait" step has status waiting and nextAt. dedupeKey stops a
// time-based trigger (no reply, quote not accepted, task overdue) from starting twice for the
// same thing.
const { Mixed, ObjectId } = mongoose.Schema.Types;

const stepLogSchema = new mongoose.Schema(
  {
    index: Number,
    type: String,
    status: { type: String, enum: ['done', 'failed', 'skipped', 'waiting'] },
    detail: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const automationRunSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    workflowId: { type: ObjectId, ref: 'Workflow', required: true },
    workflowName: { type: String, default: '' },
    trigger: { type: String, required: true },
    event: { type: Mixed, default: () => ({}) }, // a short summary of what happened
    subject: {
      leadId: { type: ObjectId, ref: 'Lead' },
      contactId: { type: ObjectId, ref: 'Contact' },
      conversationId: { type: ObjectId, ref: 'Conversation' },
      orderId: { type: ObjectId, ref: 'Order' },
      quotationId: { type: ObjectId, ref: 'Quotation' },
      taskId: { type: ObjectId, ref: 'Task' },
      label: { type: String, default: '' }, // e.g. the customer's name, for the log list
    },
    chain: { type: [ObjectId], default: [] }, // workflows that led to this run (loop guard)
    status: { type: String, enum: RUN_STATUSES, default: 'running' },
    stepIndex: { type: Number, default: 0 },
    steps: { type: [stepLogSchema], default: [] },
    nextAt: { type: Date },
    dedupeKey: { type: String },
    error: { type: String, default: '' },
    finishedAt: { type: Date },
  },
  { timestamps: true },
);

automationRunSchema.index({ organizationId: 1, createdAt: -1 });
automationRunSchema.index({ organizationId: 1, workflowId: 1, createdAt: -1 });
automationRunSchema.index({ organizationId: 1, 'subject.leadId': 1, createdAt: -1 });
automationRunSchema.index({ workflowId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });

module.exports = mongoose.model('AutomationRun', automationRunSchema);
