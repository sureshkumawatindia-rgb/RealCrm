const mongoose = require('mongoose');
const Pipeline = require('../models/Pipeline');
const Lead = require('../models/Lead');
const LeadStageEvent = require('../models/LeadStageEvent');
const Task = require('../models/Task');
const CalendarEvent = require('../models/CalendarEvent');
const OrganizationMember = require('../models/OrganizationMember');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { indiaDate } = require('../utils/dates');
const { searchFilter } = require('../utils/listQuery');
const { visibilityFilter, privacyFilter } = require('./access');
const { OPEN_STAGES, STAGE_PROBABILITY } = require('../constants/crm');
const { MAX_PIPELINES, DEFAULT_PIPELINE_NAME, DEFAULT_STAGES, DEFAULT_QUIET_DAYS, BOARD_COLUMN_MAX } = require('../constants/pipelines');

// Pipelines (Phase 5, D84): the company's own stages over the fixed ones. Lead.stage stays the
// fixed stage (its kind) that reports, automation and quotations read; Lead.pipelineId and
// pipelineStageId say where it sits on the board. A lead with no pipeline is in the default one;
// a stage id that no longer fits its kind shows at the first stage of that kind (effectiveStage).
// Every move writes one immutable LeadStageEvent with the time spent in the stage it left.
const LEAD_MODULES = ['leads', 'deals'];
const DAY_MS = 24 * 60 * 60 * 1000;

const oid = (id) => new mongoose.Types.ObjectId(String(id));

// --- reading pipelines ------------------------------------------------------------------------
// The company's default pipeline, made the first time it is needed (once, even when asked twice
// at the same moment: one default per company is a unique index).
async function ensureDefault(organizationId, session) {
  const found = await Pipeline.findOne({ organizationId, isDefault: true }).session(session || null);
  if (found) return found;
  try {
    const [made] = await Pipeline.create([{ organizationId, name: DEFAULT_PIPELINE_NAME, isDefault: true, order: 0, stages: DEFAULT_STAGES }], { session });
    return made;
  } catch (error) {
    if (error.code !== 11000) throw error;
    return Pipeline.findOne({ organizationId, isDefault: true }).session(session || null);
  }
}

async function pipelinesOf(organizationId, session) {
  await ensureDefault(organizationId, session);
  return Pipeline.find({ organizationId }).sort({ order: 1, createdAt: 1 }).session(session || null);
}

// The lead's pipeline (the default one when it has none, or when its own was deleted).
async function pipelineOfLead(lead, session) {
  if (lead.pipelineId) {
    const own = await Pipeline.findOne({ _id: lead.pipelineId, organizationId: lead.organizationId }).session(session || null);
    if (own) return own;
  }
  return ensureDefault(lead.organizationId, session);
}

const firstOfKind = (pipeline, kind) => pipeline.stages.find((stage) => stage.kind === kind) || null;
// The stage a lead of this kind sits at: the first of its kind; a pipeline without that kind,
// the last stage of an earlier kind (a quotation sent in a pipeline with no "Quote Sent" step stays
// at its sample or contact step); else the first stage.
function stageForKind(pipeline, kind) {
  const exact = firstOfKind(pipeline, kind);
  if (exact) return exact;
  const rank = OPEN_STAGES.indexOf(kind);
  const earlier = pipeline.stages.filter((stage) => OPEN_STAGES.indexOf(stage.kind) < rank);
  return earlier[earlier.length - 1] || pipeline.stages[0] || null;
}
const findStage = (pipeline, id) => (id ? pipeline.stages.find((stage) => String(stage._id) === String(id)) || null : null);

// Where an open lead shows: its own stage when that stage still has its kind, else the first
// stage of its kind (old leads, or a fixed stage changed by a quotation, an automation, the API).
function effectiveStage(pipeline, stageId, kind) {
  if (!OPEN_STAGES.includes(kind)) return findStage(pipeline, stageId);
  const own = findStage(pipeline, stageId);
  return own && own.kind === kind ? own : stageForKind(pipeline, kind);
}

// One side of a move: the board step (its name), and the lead's fixed stage then (kind), which
// can differ from the step's own kind (a quotation sent in a pipeline with no Quote Sent step).
const sideOf = (stage, kind) => (stage && OPEN_STAGES.includes(kind) ? { stageId: stage._id, name: stage.name, kind } : { stageId: null, name: kind, kind });

function serialize(pipeline, counts = {}) {
  return {
    id: pipeline._id,
    name: pipeline.name,
    isDefault: pipeline.isDefault,
    order: pipeline.order,
    stages: pipeline.stages.map((stage) => ({ id: stage._id, name: stage.name, kind: stage.kind, probability: stage.probability, quietDays: stage.quietDays })),
    openLeads: counts[String(pipeline._id)] || 0,
    createdAt: pipeline.createdAt,
  };
}

// GET /pipelines — with how many open leads each holds (those with no pipeline count in the default).
async function list(req) {
  const organizationId = req.tenant.organizationId;
  const pipelines = await pipelinesOf(organizationId);
  const defaultId = String(pipelines.find((p) => p.isDefault)._id);
  const rows = await Lead.aggregate([
    { $match: { organizationId: oid(organizationId), deletedAt: null, stage: { $in: OPEN_STAGES } } },
    { $group: { _id: '$pipelineId', count: { $sum: 1 } } },
  ]);
  const known = new Set(pipelines.map((p) => String(p._id)));
  const counts = {};
  for (const row of rows) {
    const key = row._id && known.has(String(row._id)) ? String(row._id) : defaultId;
    counts[key] = (counts[key] || 0) + row.count;
  }
  return pipelines.map((pipeline) => serialize(pipeline, counts));
}

async function findOwn(req, id, session) {
  await ensureDefault(req.tenant.organizationId, session);
  const pipeline = mongoose.isValidObjectId(id) ? await Pipeline.findOne({ _id: id, organizationId: req.tenant.organizationId }).session(session || null) : null;
  if (!pipeline) throw httpError(404, 'NOT_FOUND', 'Pipeline not found');
  return pipeline;
}

const get = async (req, id) => serialize(await findOwn(req, id));

// --- changing pipelines (owners and admins) -----------------------------------------------------
const stageDoc = (stage) => ({
  ...(stage.id && mongoose.isValidObjectId(stage.id) && { _id: stage.id }),
  name: stage.name,
  kind: stage.kind,
  probability: stage.probability ?? STAGE_PROBABILITY[stage.kind],
  quietDays: stage.quietDays ?? DEFAULT_QUIET_DAYS,
});

function assertStages(stages) {
  const names = stages.map((stage) => stage.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) throw httpError(400, 'VALIDATION_ERROR', 'Two stages have the same name.', [{ field: 'stages', code: 'DUPLICATE_STAGE', message: 'Give each stage its own name.' }]);
}

async function assertName(req, name, exceptId) {
  const clash = await Pipeline.exists({ organizationId: req.tenant.organizationId, name: new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), ...(exceptId && { _id: { $ne: exceptId } }) });
  if (clash) throw httpError(409, 'NAME_TAKEN', `There is already a pipeline called "${name}".`);
}

async function create(req, { name, stages }) {
  const organizationId = req.tenant.organizationId;
  const existing = await pipelinesOf(organizationId);
  if (existing.length >= MAX_PIPELINES) throw httpError(409, 'LIMIT', `A company can have at most ${MAX_PIPELINES} pipelines.`);
  assertStages(stages);
  await assertName(req, name);
  const pipeline = await Pipeline.create({ organizationId, name, order: existing.length, stages: stages.map((stage) => stageDoc({ ...stage, id: undefined })), createdById: req.user._id });
  await audit(req, { action: 'pipeline.created', entityType: 'Pipeline', entityId: pipeline._id, changes: { name, stages: stages.map((s) => s.name) } });
  return serialize(pipeline);
}

// The open leads that show in a pipeline (those with no pipeline show in the default one).
const openLeadsOf = (req, pipeline, session) => Lead.find({
  organizationId: req.tenant.organizationId,
  stage: { $in: OPEN_STAGES },
  ...(pipeline.isDefault ? { $or: [{ pipelineId: pipeline._id }, { pipelineId: null }] } : { pipelineId: pipeline._id }),
}).session(session || null);

// Puts open leads where targetOf(lead, currentStage) says (null: they stay), each with a history
// entry; a stage of another kind changes the lead's fixed stage too.
async function relocate(req, leads, { fromPipeline, toPipeline, targetOf, session }) {
  let moved = 0;
  for (const lead of leads) {
    const current = effectiveStage(fromPipeline, lead.pipelineStageId, lead.stage);
    const target = targetOf(lead, current);
    if (!target) continue;
    const samePlace = String(fromPipeline._id) === String(toPipeline._id) && current && String(current._id) === String(target._id) && target.kind === lead.stage;
    if (samePlace) continue;
    await recordMove(req, lead, { pipeline: fromPipeline, stage: current, kind: lead.stage }, { pipeline: toPipeline, stage: target }, { source: 'pipeline', session });
    lead.pipelineId = toPipeline._id;
    lead.pipelineStageId = target._id;
    lead.pipelineStageAt = new Date();
    if (target.kind !== lead.stage) {
      lead.stage = target.kind;
      lead.stageChangedAt = new Date();
    }
    lead.probability = target.probability;
    lead.version += 1;
    await lead.save({ session });
    moved += 1;
  }
  return moved;
}

// PATCH /pipelines/:id — name, order and stages (the whole list, in order; existing stages keep
// their id). A stage that goes away while leads sit in it needs moveStages[its id] = a kept stage;
// a kept stage given another kind takes its leads' fixed stage along.
async function update(req, id, body) {
  let result;
  let moved = 0;
  await mongoose.connection.transaction(async (session) => {
    moved = 0;
    const pipeline = await findOwn(req, id, session);
    if (body.name !== undefined) {
      await assertName(req, body.name, pipeline._id);
      pipeline.name = body.name;
    }
    if (body.order !== undefined) pipeline.order = body.order;
    if (body.stages) {
      assertStages(body.stages);
      const before = { _id: pipeline._id, name: pipeline.name, isDefault: pipeline.isDefault, stages: pipeline.stages.map((stage) => stage.toObject()) };
      const kept = new Set(body.stages.filter((s) => s.id).map((s) => String(s.id)));
      const unknown = [...kept].find((stageId) => !findStage(before, stageId));
      if (unknown) throw httpError(400, 'VALIDATION_ERROR', 'A stage does not belong to this pipeline.', [{ field: 'stages', code: 'UNKNOWN_STAGE', message: unknown }]);
      const leads = await openLeadsOf(req, pipeline, session);
      const occupied = {};
      for (const lead of leads) {
        const stage = effectiveStage(before, lead.pipelineStageId, lead.stage);
        if (stage) occupied[String(stage._id)] = (occupied[String(stage._id)] || 0) + 1;
      }
      const removed = before.stages.filter((stage) => !kept.has(String(stage._id)) && occupied[String(stage._id)]);
      for (const stage of removed) {
        const target = body.moveStages?.[String(stage._id)];
        if (!target) throw httpError(400, 'MOVE_TARGET_REQUIRED', `"${stage.name}" has ${occupied[String(stage._id)]} open lead(s). Choose the stage they move to.`, [{ field: `moveStages.${stage._id}`, code: 'MOVE_TARGET_REQUIRED', message: stage.name }]);
        if (!kept.has(String(target))) throw httpError(400, 'STAGE_NOT_IN_PIPELINE', 'Move the leads to a stage that stays in this pipeline.');
      }
      pipeline.stages = body.stages.map(stageDoc);
      await pipeline.save({ session });
      moved = await relocate(req, leads, {
        fromPipeline: before,
        toPipeline: pipeline,
        session,
        targetOf: (lead, current) => {
          if (!current) return stageForKind(pipeline, lead.stage);
          const goesTo = body.moveStages?.[String(current._id)];
          if (goesTo && !kept.has(String(current._id))) return findStage(pipeline, goesTo);
          const stays = findStage(pipeline, current._id);
          return stays && stays.kind !== lead.stage ? stays : null;
        },
      });
    }
    await pipeline.save({ session });
    result = pipeline;
  });
  await audit(req, { action: 'pipeline.updated', entityType: 'Pipeline', entityId: result._id, changes: { fields: Object.keys(body), moved } });
  return serialize(result);
}

// DELETE /pipelines/:id?moveTo= — its open leads go to the first stage of their kind there.
async function remove(req, id, { moveTo } = {}) {
  let moved = 0;
  await mongoose.connection.transaction(async (session) => {
    moved = 0;
    const pipeline = await findOwn(req, id, session);
    if (pipeline.isDefault) throw httpError(409, 'DEFAULT_PIPELINE', 'The default pipeline cannot be deleted; rename it or change its stages instead.');
    const leads = await openLeadsOf(req, pipeline, session);
    if (leads.length) {
      if (!moveTo) throw httpError(409, 'PIPELINE_IN_USE', `This pipeline has ${leads.length} open lead(s). Choose the pipeline they move to.`);
      const target = await findOwn(req, moveTo, session);
      if (String(target._id) === String(pipeline._id)) throw httpError(400, 'VALIDATION_ERROR', 'Choose another pipeline.');
      moved = await relocate(req, leads, { fromPipeline: pipeline, toPipeline: target, session, targetOf: (lead) => stageForKind(target, lead.stage) });
    }
    await pipeline.softDelete({ session });
  });
  await audit(req, { action: 'pipeline.deleted', entityType: 'Pipeline', entityId: id, changes: { moved, moveTo: moveTo || null } });
  return { deleted: true, moved };
}

// --- history ----------------------------------------------------------------------------------
// One immutable entry for a move. from: { pipeline, stage, kind } before; to: { pipeline, stage }
// (stage null for Won and Lost: then toKind says which).
async function recordMove(req, lead, from, to, { source, session, toKind, at = new Date(), enteredAt = lead.pipelineStageAt || lead.stageChangedAt || lead.createdAt }) {
  const fromSide = sideOf(from.stage, from.kind);
  const kind = toKind || to.stage?.kind;
  const toSide = sideOf(to.stage, kind);
  await LeadStageEvent.create([{
    organizationId: lead.organizationId,
    leadId: lead._id,
    pipelineId: to.pipeline?._id || from.pipeline?._id,
    pipelineName: to.pipeline?.name || from.pipeline?.name || '',
    from: fromSide,
    to: toSide,
    at,
    msInFrom: enteredAt ? Math.max(at.getTime() - new Date(enteredAt).getTime(), 0) : null,
    memberId: req?.member?._id,
    actorName: req?.user?.name || (source === 'migration' ? 'System' : ''),
    source,
  }], { session });
}

// After the fixed stage changed somewhere else (an edit, a quotation, an automation, convert):
// the lead follows within its own pipeline, and the move is recorded. Call before lead.save;
// fromKind: the fixed stage before; enteredAt is read from the lead (set before the change).
async function followKind(req, lead, { fromKind, fromStageId, source, session, enteredAt }) {
  const pipeline = await pipelineOfLead(lead, session);
  const fromStage = effectiveStage(pipeline, fromStageId, fromKind);
  const open = OPEN_STAGES.includes(lead.stage);
  const toStage = open ? (fromStage && fromStage.kind === lead.stage ? fromStage : stageForKind(pipeline, lead.stage)) : null;
  await recordMove(req, lead, { pipeline, stage: fromStage, kind: fromKind }, { pipeline, stage: toStage }, { source, session, toKind: lead.stage, ...(enteredAt && { enteredAt }) });
  lead.pipelineId = pipeline._id;
  if (toStage) lead.pipelineStageId = toStage._id;
  else if (fromStage) lead.pipelineStageId = fromStage._id; // Won/Lost keep the last open stage
  lead.pipelineStageAt = new Date();
  if (toStage) lead.probability = toStage.probability;
}

// GET /leads/:id/stage-history (the lead is checked by the caller).
async function history(lead) {
  const entries = await LeadStageEvent.find({ organizationId: lead.organizationId, leadId: lead._id }).sort({ at: 1, _id: 1 }).lean();
  return entries.map((e) => ({ id: e._id, from: e.from, to: e.to, pipelineName: e.pipelineName, at: e.at, msInFrom: e.msInFrom, actorName: e.actorName, source: e.source }));
}

// --- the board --------------------------------------------------------------------------------
// The next open task, upcoming meeting or follow-up of each lead.
async function nextActivities(organizationId, leads) {
  const ids = leads.map((lead) => lead._id);
  const today = indiaDate(0);
  const [tasks, events] = await Promise.all([
    Task.find({ organizationId, relatedType: 'Lead', relatedId: { $in: ids }, status: { $ne: 'Done' } }).select('title dueDate relatedId').lean(),
    CalendarEvent.find({ organizationId, relatedType: 'Lead', relatedId: { $in: ids }, date: { $gte: today } }).select('title date startTime relatedId').lean(),
  ]);
  const next = new Map();
  const offer = (leadId, item) => {
    const key = String(leadId);
    const current = next.get(key);
    if (!current || item.sortKey < current.sortKey) next.set(key, item);
  };
  for (const task of tasks) offer(task.relatedId, { type: 'task', title: task.title, date: task.dueDate || '', sortKey: task.dueDate || '9999' });
  for (const event of events) offer(event.relatedId, { type: 'event', title: event.title, date: event.date, time: event.startTime || '', sortKey: `${event.date}${event.startTime || ''}` });
  for (const lead of leads) {
    if (lead.followUpAt) {
      const date = indiaDate(0, new Date(lead.followUpAt));
      offer(lead._id, { type: 'followUp', title: '', date, sortKey: date });
    }
  }
  return next;
}

function cardOf(lead, stage, next, names, now, today) {
  const idleDays = Math.floor((now - new Date(lead.lastActivityAt || lead.createdAt).getTime()) / DAY_MS);
  const activity = next.get(String(lead._id)) || null;
  return {
    id: lead._id,
    title: lead.title || 'Enquiry',
    contact: lead.contactId?.name || '',
    company: lead.contactId?.company || '',
    valuePaise: lead.expectedValuePaise || 0,
    ownerId: lead.ownerId || null,
    owner: lead.ownerId ? names.get(String(lead.ownerId)) || '' : '',
    stage: lead.stage,
    pipelineStageId: stage ? stage._id : null,
    version: lead.version,
    idleDays,
    nextActivity: activity ? { type: activity.type, title: activity.title, date: activity.date, time: activity.time || '' } : null,
    flags: {
      overdue: Boolean(activity && activity.date && activity.date < today),
      noNextStep: !activity,
      quiet: Boolean(stage && stage.quietDays > 0 && idleDays >= stage.quietDays),
    },
  };
}

async function memberNames(organizationId) {
  const members = await OrganizationMember.find({ organizationId }).populate('userId', 'name email').lean();
  return new Map(members.map((m) => [String(m._id), m.displayName || m.userId?.name || m.userId?.email || '']));
}

const weighted = (cards, probability) => cards.reduce((sum, card) => sum + Math.round((card.valuePaise * probability) / 100), 0);

// GET /pipelines/:id/board (and /summary: the same totals, no cards). Members who see only
// their own leads get their own cards and totals.
async function board(req, id, { ownerId, q } = {}, { cards = true } = {}) {
  const organizationId = req.tenant.organizationId;
  const pipeline = await findOwn(req, id);
  const now = Date.now();
  const today = indiaDate(0);
  const scope = {
    organizationId,
    ...visibilityFilter(req, LEAD_MODULES),
    ...privacyFilter(req),
    ...(ownerId && { ownerId }),
    ...(pipeline.isDefault ? { $or: [{ pipelineId: pipeline._id }, { pipelineId: null }, { pipelineId: { $exists: false } }] } : { pipelineId: pipeline._id }),
  };
  if (q) {
    const text = searchFilter(q, ['title']).$or;
    scope.$and = [{ $or: text }];
  }
  const leads = await Lead.find({ ...scope, stage: { $in: OPEN_STAGES } })
    .populate('contactId', 'name company').select('title stage pipelineStageId expectedValuePaise ownerId version lastActivityAt createdAt followUpAt contactId').sort({ lastActivityAt: -1 }).lean();
  const since = new Date(now - 30 * DAY_MS);
  const closed = await Lead.find({ ...scope, stage: { $in: ['Won', 'Lost'] }, stageChangedAt: { $gte: since } }).select('stage expectedValuePaise').lean();
  const [next, names] = await Promise.all([nextActivities(organizationId, leads), memberNames(organizationId)]);
  const byStage = new Map(pipeline.stages.map((stage) => [String(stage._id), []]));
  for (const lead of leads) {
    const stage = effectiveStage(pipeline, lead.pipelineStageId, lead.stage);
    if (stage) byStage.get(String(stage._id)).push(cardOf(lead, stage, next, names, now, today));
  }
  const columns = pipeline.stages.map((stage) => {
    const all = byStage.get(String(stage._id));
    return {
      stage: { id: stage._id, name: stage.name, kind: stage.kind, probability: stage.probability, quietDays: stage.quietDays },
      count: all.length,
      valuePaise: all.reduce((sum, card) => sum + card.valuePaise, 0),
      weightedPaise: weighted(all, stage.probability),
      flags: { overdue: all.filter((c) => c.flags.overdue).length, noNextStep: all.filter((c) => c.flags.noNextStep).length, quiet: all.filter((c) => c.flags.quiet).length },
      ...(cards && { leads: all.slice(0, BOARD_COLUMN_MAX), more: Math.max(all.length - BOARD_COLUMN_MAX, 0) }),
    };
  });
  const closedTotal = (stage) => {
    const list = closed.filter((lead) => lead.stage === stage);
    return { count: list.length, valuePaise: list.reduce((sum, lead) => sum + (lead.expectedValuePaise || 0), 0) };
  };
  return {
    pipeline: serialize(pipeline),
    columns,
    totals: {
      count: columns.reduce((s, c) => s + c.count, 0),
      valuePaise: columns.reduce((s, c) => s + c.valuePaise, 0),
      weightedPaise: columns.reduce((s, c) => s + c.weightedPaise, 0),
    },
    last30Days: { won: closedTotal('Won'), lost: closedTotal('Lost') },
  };
}

module.exports = {
  LEAD_MODULES, ensureDefault, pipelinesOf, pipelineOfLead, firstOfKind, stageForKind, findStage, effectiveStage,
  list, get, create, update, remove, history, recordMove, followKind, board, findOwn, serialize,
};
