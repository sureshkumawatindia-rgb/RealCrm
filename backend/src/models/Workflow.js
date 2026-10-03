const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { AUTOMATION_STATUSES } = require('../constants/crm');
const { TRIGGER_TYPES, ACTION_TYPES } = require('../constants/automation');

// An automation (Phase 6): "when <trigger>, if <conditions>, do <steps>". Each time it starts
// for a lead (or order, task …) is an AutomationRun with its own log. Steps run in order; a
// "wait" step pauses the run. Phase 2 workflows were moved here by migration 003 (paused, D32).
const { Mixed, ObjectId } = mongoose.Schema.Types;

const triggerSchema = new mongoose.Schema(
  {
    type: { type: String, enum: TRIGGER_TYPES, required: true },
    // lead.created { sources[] } · message.received { keywords[] } · lead.stage_changed
    // { toStages[], fromStages[] } · lead.no_reply { hours } · quotation.not_accepted { days }
    // · order.stage_changed { toStages[] }
    params: { type: Mixed, default: () => ({}) },
  },
  { _id: false },
);
const conditionSchema = new mongoose.Schema({ field: String, op: String, value: Mixed }, { _id: false });
const stepSchema = new mongoose.Schema({ type: { type: String, enum: ACTION_TYPES, required: true }, params: { type: Mixed, default: () => ({}) } }, { _id: false });

const workflowSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: AUTOMATION_STATUSES, default: 'Active' },
    trigger: { type: triggerSchema, required: true },
    conditions: { type: [conditionSchema], default: [] },
    steps: { type: [stepSchema], default: [] },
    // Signs webhook calls (X-CRM-Signature: sha256=…), made when the first webhook step is added.
    webhookSecret: { type: String },
    notes: { type: [String], default: [] }, // e.g. what migration 003 could not carry over
    ownerId: { type: ObjectId, ref: 'OrganizationMember' },
    stats: {
      runs: { type: Number, default: 0 },
      done: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      lastRunAt: { type: Date },
    },
    schemaVersion: { type: Number, default: 2 },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: ObjectId, ref: 'User' },
    createdByMemberId: { type: ObjectId, ref: 'OrganizationMember' },
  },
  { timestamps: true },
);

workflowSchema.plugin(softDelete);
workflowSchema.index({ organizationId: 1, deletedAt: 1, status: 1 });
workflowSchema.index({ organizationId: 1, status: 1, 'trigger.type': 1 });
workflowSchema.index({ organizationId: 1, ownerId: 1 });
workflowSchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('Workflow', workflowSchema);
