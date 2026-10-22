const Organization = require('../models/Organization');
const Lead = require('../models/Lead');
const pipelineService = require('../services/pipelineService');

// Pipelines (D84): every company gets its default "Sales" pipeline, and every lead without a
// pipeline is put in it, at the stage of its kind (Won and Lost at the last open stage), entering
// that stage when its fixed stage last changed. Idempotent: only leads without a pipeline are
// touched, and the default is made once per company.
async function up() {
  const organizations = await Organization.collection.find({}, { projection: { _id: 1 } }).toArray();
  let leads = 0;
  for (const { _id: organizationId } of organizations) {
    const pipeline = await pipelineService.ensureDefault(organizationId);
    const last = pipeline.stages[pipeline.stages.length - 1]._id;
    const missing = await Lead.collection.find({ organizationId, pipelineId: { $exists: false } }, { projection: { stage: 1, stageChangedAt: 1, createdAt: 1 } }).toArray();
    for (const lead of missing) {
      const result = await Lead.collection.updateOne(
        { _id: lead._id, pipelineId: { $exists: false } },
        { $set: { pipelineId: pipeline._id, pipelineStageId: ['Won', 'Lost'].includes(lead.stage) ? last : pipelineService.stageForKind(pipeline, lead.stage)._id, pipelineStageAt: lead.stageChangedAt || lead.createdAt || new Date() } },
      );
      leads += result.modifiedCount;
    }
  }
  return { organizations: organizations.length, leads };
}

module.exports = { name: '007-lead-pipelines', up };
