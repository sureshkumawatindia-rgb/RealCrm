const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { TASK_STATUSES, TASK_PRIORITIES, TASK_ORIGINS, RELATED_TYPES } = require('../constants/crm');

// A to-do for a team member. Dates are calendar dates (YYYY-MM-DD) in the organization's
// timezone, exactly as the pages show them, so nothing shifts a day across timezones.
const taskSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    assigneeId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    // Only for imported tasks whose assignee is not a team member yet.
    assigneeName: { type: String, trim: true, default: '' },
    dueDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    priority: { type: String, enum: TASK_PRIORITIES, default: 'Medium' },
    status: { type: String, enum: TASK_STATUSES, default: 'To Do' },
    completedAt: { type: Date },
    relatedType: { type: String, enum: RELATED_TYPES, default: '' },
    relatedId: { type: mongoose.Schema.Types.ObjectId },
    relatedName: { type: String, trim: true, default: '' },
    origin: { type: String, enum: TASK_ORIGINS, default: 'manual' },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
  },
  { timestamps: true },
);

taskSchema.plugin(softDelete);
taskSchema.index({ organizationId: 1, deletedAt: 1, status: 1, dueDate: 1 });
taskSchema.index({ organizationId: 1, assigneeId: 1, status: 1 });
taskSchema.index({ organizationId: 1, relatedType: 1, relatedId: 1 });
taskSchema.index({ organizationId: 1, origin: 1, createdAt: -1 });
taskSchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('Task', taskSchema);
