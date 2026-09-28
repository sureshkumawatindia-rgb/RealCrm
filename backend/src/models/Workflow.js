const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { AUTOMATION_STATUSES, WORKFLOW_TRIGGERS, WORKFLOW_ACTIONS } = require('../constants/crm');

// An automation rule: "when <trigger>, do <actions>". Only settings for now; runsCount is
// changed by the server when someone presses Run Now, never taken from the browser.
const actionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: WORKFLOW_ACTIONS, required: true },
    detail: { type: String, trim: true, default: '' },
  },
  { _id: false },
);

const workflowSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: AUTOMATION_STATUSES, default: 'Active' },
    trigger: { type: String, enum: WORKFLOW_TRIGGERS, required: true },
    actions: { type: [actionSchema], default: [] },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    runsCount: { type: Number, min: 0, default: 0 },
    lastRunAt: { type: Date },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
  },
  { timestamps: true },
);

workflowSchema.plugin(softDelete);
workflowSchema.index({ organizationId: 1, deletedAt: 1, status: 1 });
workflowSchema.index({ organizationId: 1, ownerId: 1 });
workflowSchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('Workflow', workflowSchema);
