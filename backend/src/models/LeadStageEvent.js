const mongoose = require('mongoose');
const { MOVE_SOURCES } = require('../constants/pipelines');

// One move of a lead between stages (Phase 5, D84), written in the same transaction as the move
// and never changed: names are copied in, so the history reads as it was even after a stage is
// renamed or a pipeline deleted. msInFrom: how long the lead was in the stage it left. A stage
// id is null for Won and Lost (they belong to every pipeline).
const side = {
  stageId: { type: mongoose.Schema.Types.ObjectId, default: null },
  name: { type: String, default: '' },
  kind: { type: String, default: '' },
};

const leadStageEventSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
    pipelineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pipeline' },
    pipelineName: { type: String, default: '' },
    from: side,
    to: side,
    at: { type: Date, default: Date.now },
    msInFrom: { type: Number, default: null },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    actorName: { type: String, default: '' },
    source: { type: String, enum: MOVE_SOURCES, required: true },
  },
  { versionKey: false },
);

leadStageEventSchema.index({ organizationId: 1, leadId: 1, at: 1 });
leadStageEventSchema.index({ organizationId: 1, at: -1 });

// Immutable: the model refuses to change or delete an entry.
function refuse() {
  throw Object.assign(new Error('Stage history cannot be changed.'), { statusCode: 409, code: 'HISTORY_IMMUTABLE' });
}
['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndReplace'].forEach((op) => leadStageEventSchema.pre(op, refuse));
leadStageEventSchema.pre('save', function onlyNew() {
  if (!this.isNew) refuse();
});

module.exports = mongoose.model('LeadStageEvent', leadStageEventSchema);
