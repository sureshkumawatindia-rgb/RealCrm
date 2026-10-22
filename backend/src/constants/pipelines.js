const { OPEN_STAGES, STAGE_PROBABILITY } = require('./crm');

// Pipelines (Phase 5, D84). A pipeline's stages are the company's own names; each stage has a kind,
// one of the fixed open stages, which is what reports, automation and quotations read
// (Lead.stage). Won and Lost end every pipeline.
const STAGE_KINDS = OPEN_STAGES;
const MAX_PIPELINES = 10;
const MIN_STAGES = 2;
const MAX_STAGES = 12;
const DEFAULT_QUIET_DAYS = 7;
const DEFAULT_PIPELINE_NAME = 'Sales';
const DEFAULT_STAGES = Object.freeze(STAGE_KINDS.map((kind) => ({ name: kind, kind, probability: STAGE_PROBABILITY[kind], quietDays: DEFAULT_QUIET_DAYS })));
// How a lead moved (LeadStageEvent.source).
const MOVE_SOURCES = Object.freeze(['board', 'edit', 'create', 'quotation', 'automation', 'api', 'convert', 'pipeline', 'migration']);
const BOARD_COLUMN_MAX = 300;

module.exports = { STAGE_KINDS, MAX_PIPELINES, MIN_STAGES, MAX_STAGES, DEFAULT_QUIET_DAYS, DEFAULT_PIPELINE_NAME, DEFAULT_STAGES, MOVE_SOURCES, BOARD_COLUMN_MAX };
