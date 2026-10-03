const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { AUTOMATION_STATUSES } = require('../constants/crm');
const { SEQUENCE_STEP_TYPES } = require('../constants/automation');

// A follow-up sequence (Phase 6B): steps on day 0, 2, 5 … after a customer is enrolled
// (SequenceEnrollment, one per customer), each a workflow action (WhatsApp template, task …).
// It stops for that customer when they reply on WhatsApp (stopOnReply) or their lead is won or
// lost (stopOnClose). Phase 2 sequences were moved here by migration 004 (paused, D32).
const { Mixed, ObjectId } = mongoose.Schema.Types;

const stepSchema = new mongoose.Schema(
  {
    day: { type: Number, min: 0, max: 365, required: true }, // days after enrolling
    type: { type: String, enum: SEQUENCE_STEP_TYPES, required: true },
    params: { type: Mixed, default: () => ({}) },
  },
  { _id: false },
);

const sequenceSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: AUTOMATION_STATUSES, default: 'Active' },
    steps: { type: [stepSchema], default: [] }, // in day order
    stopOnReply: { type: Boolean, default: true },
    stopOnClose: { type: Boolean, default: true },
    // A step due outside working hours (Settings → Lead rules) waits for the next opening.
    workingHoursOnly: { type: Boolean, default: true },
    notes: { type: [String], default: [] }, // e.g. what migration 004 could not carry over
    ownerId: { type: ObjectId, ref: 'OrganizationMember' },
    stats: {
      enrolled: { type: Number, default: 0 },
      active: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
      stopped: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      lastEnrolledAt: { type: Date },
    },
    schemaVersion: { type: Number, default: 2 },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: ObjectId, ref: 'User' },
    createdByMemberId: { type: ObjectId, ref: 'OrganizationMember' },
  },
  { timestamps: true },
);

sequenceSchema.plugin(softDelete);
sequenceSchema.index({ organizationId: 1, deletedAt: 1, status: 1 });
sequenceSchema.index({ organizationId: 1, ownerId: 1 });
sequenceSchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('Sequence', sequenceSchema);
