const Joi = require('joi');
const { objectId } = require('./common');
const { STAGE_KINDS, MIN_STAGES, MAX_STAGES } = require('../constants/pipelines');

// Pipelines (Phase 5, D84).
const stage = Joi.object({
  id: objectId, // an existing stage keeps its id (and its leads)
  name: Joi.string().trim().min(1).max(40).required(),
  kind: Joi.string().valid(...STAGE_KINDS).required(),
  probability: Joi.number().integer().min(0).max(100),
  quietDays: Joi.number().integer().min(0).max(365),
});
const stages = Joi.array().items(stage).min(MIN_STAGES).max(MAX_STAGES)
  .messages({ 'array.min': `A pipeline needs at least ${MIN_STAGES} stages.`, 'array.max': `A pipeline has at most ${MAX_STAGES} stages.` });

module.exports = {
  pipelineCreate: Joi.object({ name: Joi.string().trim().min(1).max(60).required(), stages: stages.required() }),
  pipelinePatch: Joi.object({
    name: Joi.string().trim().min(1).max(60),
    order: Joi.number().integer().min(0).max(100),
    stages,
    // { removedStageId: keptStageId } for stages that go away with open leads in them.
    moveStages: Joi.object().pattern(objectId, objectId),
  }).min(1),
  pipelineDelete: Joi.object({ moveTo: objectId }),
  board: Joi.object({ ownerId: objectId, q: Joi.string().trim().max(100).allow('') }),
};
