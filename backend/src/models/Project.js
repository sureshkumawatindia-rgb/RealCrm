const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { PROJECT_STATUSES } = require('../constants/projects');

// A delivery project after the sale (Phase 10, D92): what was sold is delivered, installed or
// set up. It may come from a won deal (leadId, at most one live project per deal: a second
// "start the project" or the automatic one on Won finds this one) and belongs to its customer.
// Milestones are kept here; its tasks are ordinary tasks (relatedType Project), so they show on
// the Tasks page. Progress is worked out from them when read.
const { ObjectId } = mongoose.Schema.Types;

const milestoneSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  dueDate: { type: String, match: /^(\d{4}-\d{2}-\d{2})?$/, default: '' },
  done: { type: Boolean, default: false },
  doneAt: { type: Date },
});

const projectSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    number: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: PROJECT_STATUSES, default: 'not_started' },
    leadId: { type: ObjectId, ref: 'Lead' },
    formerLeadId: { type: ObjectId, ref: 'Lead' }, // a deleted project's deal (its leadId is let go)
    contactId: { type: ObjectId, ref: 'Contact' },
    managerId: { type: ObjectId, ref: 'OrganizationMember' },
    memberIds: { type: [ObjectId], ref: 'OrganizationMember', default: [] },
    startDate: { type: String, match: /^(\d{4}-\d{2}-\d{2})?$/, default: '' },
    dueDate: { type: String, match: /^(\d{4}-\d{2}-\d{2})?$/, default: '' },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    valuePaise: { type: Number, min: 0, default: 0 },
    templateId: { type: ObjectId, ref: 'ProjectTemplate' },
    milestones: { type: [milestoneSchema], default: [] },
    completedAt: { type: Date },
    createdById: { type: ObjectId, ref: 'User' },
    createdByMemberId: { type: ObjectId, ref: 'OrganizationMember' },
  },
  { timestamps: true },
);

projectSchema.plugin(softDelete);
// One live project per deal: the guard that makes "start the project" and "on Won" happen once
// (a deleted project gives its leadId up, so the deal can start another).
projectSchema.index({ organizationId: 1, leadId: 1 }, { unique: true, partialFilterExpression: { leadId: { $type: 'objectId' } } });
projectSchema.index({ organizationId: 1, deletedAt: 1, status: 1, dueDate: 1 });
projectSchema.index({ organizationId: 1, contactId: 1 });
projectSchema.index({ organizationId: 1, managerId: 1 });
projectSchema.index({ organizationId: 1, memberIds: 1 });

module.exports = mongoose.model('Project', projectSchema);
