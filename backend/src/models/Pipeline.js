const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { STAGE_KINDS, DEFAULT_QUIET_DAYS } = require('../constants/pipelines');

// A sales pipeline of a company (Phase 5, D84): its own stages in order. Each stage's kind is the
// fixed stage it stands for (Lead.stage), its probability weighs the board's value, and quietDays
// flags a lead with no activity for that long (0: never). Won and Lost end every pipeline.
// Deleted pipelines stay (soft delete) so closed leads and their history keep the reference.
const stageSchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true, maxlength: 40 },
  kind: { type: String, enum: STAGE_KINDS, required: true },
  probability: { type: Number, min: 0, max: 100, required: true },
  quietDays: { type: Number, min: 0, max: 365, default: DEFAULT_QUIET_DAYS },
});

const pipelineSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, trim: true, required: true, maxlength: 60 },
    order: { type: Number, default: 0 },
    isDefault: { type: Boolean, default: false },
    stages: { type: [stageSchema], default: [] },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

pipelineSchema.plugin(softDelete);
pipelineSchema.index({ organizationId: 1, deletedAt: 1, order: 1 });
// One default per company: made once, even when two requests ask at the same moment.
pipelineSchema.index({ organizationId: 1, isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });

module.exports = mongoose.model('Pipeline', pipelineSchema);
