const mongoose = require('mongoose');
const { ENROLLMENT_STATUSES } = require('../constants/automation');

// One customer going through one sequence (Phase 6B). stepIndex is the next step, due at
// nextAt (a "sequence.step" job). A customer is in a sequence at most once at a time; after it
// completes or stops they can be enrolled again.
const { ObjectId } = mongoose.Schema.Types;

const stepLogSchema = new mongoose.Schema(
  {
    index: Number,
    day: Number,
    type: String,
    status: { type: String, enum: ['done', 'failed', 'skipped'] },
    detail: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const enrollmentSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    sequenceId: { type: ObjectId, ref: 'Sequence', required: true },
    sequenceName: { type: String, default: '' },
    contactId: { type: ObjectId, ref: 'Contact', required: true },
    leadId: { type: ObjectId, ref: 'Lead' }, // the customer's open lead when enrolled
    label: { type: String, default: '' }, // the customer's name, for lists
    status: { type: String, enum: ENROLLMENT_STATUSES, default: 'active' },
    enrolledAt: { type: Date, default: Date.now },
    // Who enrolled them: a person, or a workflow's "add to sequence" step.
    enrolledBy: {
      kind: { type: String, enum: ['member', 'workflow'], default: 'member' },
      memberId: { type: ObjectId, ref: 'OrganizationMember' },
      workflowId: { type: ObjectId, ref: 'Workflow' },
      name: { type: String, default: '' },
    },
    chain: { type: [ObjectId], default: [] }, // workflows that led here (loop guard)
    stepIndex: { type: Number, default: 0 },
    nextAt: { type: Date },
    steps: { type: [stepLogSchema], default: [] },
    stopReason: { type: String, default: '' }, // replied, won, lost, by hand, paused …
    error: { type: String, default: '' },
    finishedAt: { type: Date },
  },
  { timestamps: true },
);

enrollmentSchema.index({ organizationId: 1, sequenceId: 1, createdAt: -1 });
enrollmentSchema.index({ organizationId: 1, contactId: 1, status: 1 });
enrollmentSchema.index({ organizationId: 1, leadId: 1, createdAt: -1 });
enrollmentSchema.index({ sequenceId: 1, contactId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });

module.exports = mongoose.model('SequenceEnrollment', enrollmentSchema);
