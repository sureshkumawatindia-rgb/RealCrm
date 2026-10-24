const mongoose = require('mongoose');
const { TASK_PRIORITIES } = require('../constants/crm');

// A project template (Phase 10, D92), owners and admins: the milestones and tasks a new project
// starts with, each due some days after the project's start. forManager: the task is the
// project manager's (else nobody's until someone takes it).
const templateSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    days: { type: Number, min: 0, max: 730, default: 0 },
    milestones: {
      type: [new mongoose.Schema({ name: { type: String, required: true, trim: true, maxlength: 120 }, dueAfterDays: { type: Number, min: 0, max: 730, default: 0 } }, { _id: false })],
      default: [],
    },
    tasks: {
      type: [new mongoose.Schema({
        title: { type: String, required: true, trim: true, maxlength: 300 },
        milestone: { type: Number, min: 0, default: null }, // index in milestones, or none
        dueAfterDays: { type: Number, min: 0, max: 730, default: 0 },
        priority: { type: String, enum: TASK_PRIORITIES, default: 'Medium' },
        forManager: { type: Boolean, default: true },
      }, { _id: false })],
      default: [],
    },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

templateSchema.index({ organizationId: 1, name: 1 });

module.exports = mongoose.model('ProjectTemplate', templateSchema);
