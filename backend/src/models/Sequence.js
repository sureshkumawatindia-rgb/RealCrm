const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { AUTOMATION_STATUSES, SEQUENCE_TARGETS, SEQUENCE_STEP_TYPES } = require('../constants/crm');

// A follow-up cadence ("day 0 email, day 2 call, ..."). Only settings for now; enrolledCount is
// changed by the server on Enroll. Real per-contact enrollments come with Phase 6.
const stepSchema = new mongoose.Schema(
  {
    day: { type: Number, min: 0, max: 365, required: true },
    type: { type: String, enum: SEQUENCE_STEP_TYPES, required: true },
    note: { type: String, trim: true, default: '' },
  },
  { _id: false },
);

const sequenceSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true },
    targetType: { type: String, enum: SEQUENCE_TARGETS, default: 'Leads' },
    status: { type: String, enum: AUTOMATION_STATUSES, default: 'Active' },
    steps: { type: [stepSchema], default: [] },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    enrolledCount: { type: Number, min: 0, default: 0 },
    lastEnrolledAt: { type: Date },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
  },
  { timestamps: true },
);

sequenceSchema.plugin(softDelete);
sequenceSchema.index({ organizationId: 1, deletedAt: 1, status: 1 });
sequenceSchema.index({ organizationId: 1, ownerId: 1 });
sequenceSchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('Sequence', sequenceSchema);
