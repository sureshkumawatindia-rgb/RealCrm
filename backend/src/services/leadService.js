const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const Contact = require('../models/Contact');
const LeadActivity = require('../models/LeadActivity');
const Product = require('../models/Product');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { toPage, paginationMeta } = require('../utils/pagination');
const { searchFilter, sortSpec } = require('../utils/listQuery');
const { STAGE_PROBABILITY } = require('../constants/crm');
const { visibilityFilter, privacyFilter, resolveOwnerId, ownerPatch } = require('./access');
const contactService = require('./contactService');
const customFieldService = require('./customFieldService');
const customFieldFilters = require('./customFieldFilters');
const lookupService = require('./lookupService');
const automationEvents = require('./automation/events');
const pipelineService = require('./pipelineService');
const OrganizationMember = require('../models/OrganizationMember');
const notificationService = require('./notificationService');
const { can } = require('../constants/permissions');

// Leads are shown on the Leads page and, as a Kanban, on the Deals page (D13).
const MODULES = ['leads', 'deals'];
const EDITABLE = ['title', 'source', 'productId', 'quantity', 'expectedValuePaise', 'expectedCloseDate', 'followUpAt', 'notes', 'noteEntries'];
const SORTS = ['createdAt', 'updatedAt', 'expectedValuePaise', 'expectedCloseDate', 'followUpAt', 'stage', 'title'];
const CONTACT_SELECT = 'name email phone company lifecycle';

function contactSummary(contact) {
  if (!contact || !contact._id) return null;
  return { id: contact._id, name: contact.name, email: contact.email, phone: contact.phone, company: contact.company, lifecycle: contact.lifecycle };
}

// keys: the active custom fields (customFieldService.activeKeys); without them, every stored value.
// links: lookupService.linksFor — the names of the records its link fields point to (D75).
// A kept touch (D79), or null when there is none.
const touchOf = (t) => (t?.channel ? { channel: t.channel, source: t.source || '', medium: t.medium || '', campaign: t.campaign || '', at: t.at || null } : null);

function serializeLead(lead, keys, links) {
  const contact = contactSummary(lead.contactId);
  return {
    id: lead._id,
    contactId: contact ? contact.id : lead.contactId,
    contact,
    title: lead.title,
    stage: lead.stage,
    probability: lead.probability,
    lostReason: lead.lostReason,
    source: lead.source,
    productId: lead.productId || null,
    quantity: lead.quantity ?? null,
    expectedValuePaise: lead.expectedValuePaise ?? null,
    expectedCloseDate: lead.expectedCloseDate || null,
    followUpAt: lead.followUpAt || null,
    ownerId: lead.ownerId || null,
    notes: lead.notes,
    noteEntries: lead.noteEntries,
    stageChangedAt: lead.stageChangedAt || null,
    // Where it sits on the board (D84); none: the default pipeline.
    pipelineId: lead.pipelineId || null,
    pipelineStageId: lead.pipelineStageId || null,
    convertedAt: lead.convertedAt || null,
    // Where it came from (D79): the first enquiry's touch and the latest one.
    attribution: lead.attribution?.first?.channel || lead.attribution?.last?.channel ? { first: touchOf(lead.attribution.first), last: touchOf(lead.attribution.last) } : null,
    lastActivityAt: lead.lastActivityAt || null,
    // Hot / warm / cold and why (G2, D106); null for a closed lead or one not scored yet.
    score: lead.score?.band ? { points: lead.score.points, band: lead.score.band, reasons: lead.score.reasons || [], at: lead.score.at || null } : null,
    version: lead.version,
    customFields: customFieldService.visibleValues(lead.customFields, keys),
    customFieldLinks: links?.get(String(lead._id)) || {},
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  };
}

const scope = (req) => ({ organizationId: req.tenant.organizationId, ...visibilityFilter(req, MODULES), ...privacyFilter(req) });

async function findVisible(req, id, session) {
  const lead = await Lead.findOne({ _id: id, ...scope(req) }).session(session || null);
  if (!lead) throw httpError(404, 'NOT_FOUND', 'Lead not found');
  return lead;
}

async function loadSerialized(req, id) {
  const lead = await Lead.findOne({ _id: id, ...scope(req) }).populate({ path: 'contactId', select: CONTACT_SELECT });
  if (!lead) throw httpError(404, 'NOT_FOUND', 'Lead not found');
  const [keys, links] = await Promise.all([customFieldService.activeKeys(req, 'lead'), lookupService.linksFor(req, 'lead', [lead])]);
  return serializeLead(lead, keys, links);
}

async function assertProduct(req, productId, session) {
  if (!productId) return;
  const exists = await Product.exists({ _id: productId, organizationId: req.tenant.organizationId }).session(session || null);
  if (!exists) throw httpError(400, 'VALIDATION_ERROR', 'Unknown product.', [{ field: 'productId', code: 'INVALID_PRODUCT', message: 'Pick a product from your catalog.' }]);
}

async function addActivity(req, lead, type, text, { meta, session } = {}) {
  await LeadActivity.create([{
    organizationId: lead.organizationId,
    leadId: lead._id,
    contactId: lead.contactId?._id || lead.contactId,
    type,
    text,
    actorUserId: req.user._id,
    actorName: req.user.name,
    meta,
  }], { session });
}

// Moves the lead to a stage. Returns true when the stage changed. Lost needs a reason.
function applyStage(lead, stage, lostReason) {
  if (!stage || stage === lead.stage) return false;
  if (stage === 'Lost') {
    const reason = String(lostReason ?? lead.lostReason ?? '').trim();
    if (!reason) throw httpError(422, 'LOST_REASON_REQUIRED', 'Please say why this lead was lost.');
    lead.lostReason = reason;
  } else {
    lead.lostReason = '';
  }
  lead.stage = stage;
  lead.probability = STAGE_PROBABILITY[stage];
  lead.stageChangedAt = new Date();
  return true;
}

// Won: the contact becomes a customer. Safe to repeat (idempotent).
async function markContactCustomer(req, lead, session) {
  if (!lead.convertedAt) lead.convertedAt = new Date();
  await Contact.updateOne(
    { _id: lead.contactId, organizationId: req.tenant.organizationId, lifecycle: { $ne: 'customer' } },
    { $set: { lifecycle: 'customer', becameCustomerAt: new Date() } },
    { session },
  );
}

// The list's filter, also used by "Download Excel" (D82) so the file has what the screen shows.
async function listFilter(req, query) {
  const organizationId = req.tenant.organizationId;
  const filter = {
    ...scope(req),
    ...(query.stage && { stage: query.stage }),
    ...(query.ownerId && { ownerId: query.ownerId }),
    ...(query.productId && { productId: query.productId }),
    ...(query.contactId && { contactId: query.contactId }),
  };
  if (query.followUpFrom || query.followUpTo) {
    filter.followUpAt = { ...(query.followUpFrom && { $gte: query.followUpFrom }), ...(query.followUpTo && { $lte: query.followUpTo }) };
  }
  // Boards (D87): several stages or sources at once, and ranges on other dates.
  if (query.stages?.length) filter.stage = { $in: query.stages };
  if (query.sources?.length) filter.source = { $in: query.sources };
  if (query.closeFrom || query.closeTo) filter.expectedCloseDate = { ...(query.closeFrom && { $gte: query.closeFrom }), ...(query.closeTo && { $lte: query.closeTo }) };
  if (query.createdFrom || query.createdTo) filter.createdAt = { ...(query.createdFrom && { $gte: query.createdFrom }), ...(query.createdTo && { $lte: query.createdTo }) };
  // cf filters on the lead's own fields must all match (D74).
  const fieldFilters = await customFieldFilters.conditions(req, 'lead', query.cf);
  if (fieldFilters.length) filter.$and = fieldFilters;
  if (query.q) {
    // Search also looks in the company's own text and dropdown fields, the lead's and its contact's.
    const [leadFields, contactFields] = await Promise.all([
      customFieldFilters.searchClauses(req, 'lead', query.q),
      customFieldFilters.searchClauses(req, 'contact', query.q),
    ]);
    const contactSearch = searchFilter(query.q, ['name', 'email', 'phone', 'phoneE164', 'company']).$or;
    const contacts = await Contact.find({ organizationId, $or: [...contactSearch, ...contactFields] }).select('_id').limit(1000);
    const text = searchFilter(query.q, ['title', 'notes']).$or;
    filter.$or = [...text, ...leadFields, { contactId: { $in: contacts.map((contact) => contact._id) } }];
  }
  return filter;
}

async function list(req, query) {
  const filter = await listFilter(req, query);
  const page = toPage(query);
  const [items, total, keys] = await Promise.all([
    Lead.find(filter).sort(sortSpec(query.sort, SORTS)).skip(page.skip).limit(page.limit).populate({ path: 'contactId', select: CONTACT_SELECT }),
    Lead.countDocuments(filter),
    customFieldService.activeKeys(req, 'lead'),
  ]);
  const links = await lookupService.linksFor(req, 'lead', items);
  return { items: items.map((lead) => serializeLead(lead, keys, links)), pagination: paginationMeta(page, total) };
}

async function create(req, body) {
  let created;
  const customFields = body.customFields === undefined
    ? undefined
    : await customFieldService.applyValues(req, 'lead', body.customFields, undefined, { isNew: true });
  const leadId = await mongoose.connection.transaction(async (session) => {
    let contact;
    if (body.contactId) {
      contact = await Contact.findOne({ _id: body.contactId, organizationId: req.tenant.organizationId }).session(session);
      if (!contact) throw httpError(400, 'VALIDATION_ERROR', 'Unknown contact.', [{ field: 'contactId', code: 'INVALID_CONTACT', message: 'Pick an existing contact.' }]);
    } else {
      contact = await contactService.findOrCreate(req, body.contact, { source: body.source || 'Manual', session });
    }
    await assertProduct(req, body.productId, session);

    const lead = new Lead({
      organizationId: req.tenant.organizationId,
      contactId: contact._id,
      ...Object.fromEntries(EDITABLE.filter((key) => key in body).map((key) => [key, body[key]])),
      customFields,
      ownerId: await resolveOwnerId(req, body.ownerId),
      lastActivityAt: new Date(),
      createdById: req.user._id,
    });
    applyStage(lead, body.stage, body.lostReason);
    if (lead.stage === 'Won') await markContactCustomer(req, lead, session);
    // Its pipeline (D84): the one asked for, else the default; the first stage of its kind.
    const pipeline = body.pipelineId ? await pipelineService.findOwn(req, body.pipelineId, session) : await pipelineService.ensureDefault(req.tenant.organizationId, session);
    const stage = ['Won', 'Lost'].includes(lead.stage) ? pipeline.stages[pipeline.stages.length - 1] : pipelineService.stageForKind(pipeline, lead.stage);
    Object.assign(lead, { pipelineId: pipeline._id, pipelineStageId: stage?._id, pipelineStageAt: new Date() });
    if (stage && stage.kind === lead.stage) lead.probability = stage.probability;
    await lead.save({ session });
    await pipelineService.recordMove(req, lead, { pipeline, stage: null, kind: '' }, { pipeline, stage: ['Won', 'Lost'].includes(lead.stage) ? null : stage }, { source: 'create', session, toKind: lead.stage, enteredAt: null });
    await addActivity(req, lead, 'Lead created', 'Lead created', { session });
    created = lead;
    return lead._id;
  });
  await audit(req, { action: 'lead.created', entityType: 'Lead', entityId: leadId });
  automationEvents.emit('lead.created', { organizationId: created.organizationId, leadId, contactId: created.contactId, source: created.source || 'Manual', key: `lead.created:${leadId}` }, req);
  return loadSerialized(req, leadId);
}

// How a change came (the stage history's source).
const sourceOf = (req, fallback) => (req.automation ? 'automation' : req.apiKey ? 'api' : fallback);

// enforceRequired: false for the public API (D73: it is never stopped by a required field).
async function update(req, id, body, { source = 'edit', enforceRequired = true } = {}) {
  let stageChange = null;
  let boardMove = null;
  await mongoose.connection.transaction(async (session) => {
    stageChange = null;
    boardMove = null;
    const lead = await findVisible(req, id, session);
    if (body.version !== undefined && body.version !== lead.version) {
      throw httpError(409, 'VERSION_CONFLICT', 'Someone else changed this lead. Reload and try again.');
    }
    if (body.contact && Object.keys(body.contact).length) {
      await contactService.updateContact(req, lead.contactId, body.contact, { session, skipVisibility: true });
    }
    if ('productId' in body) await assertProduct(req, body.productId, session);

    for (const key of EDITABLE) if (key in body) lead[key] = body[key];
    if (body.customFields !== undefined) {
      lead.customFields = await customFieldService.applyValues(req, 'lead', body.customFields, lead.customFields, { enforceRequired });
      lead.markModified('customFields');
    }
    Object.assign(lead, await ownerPatch(req, body));
    const from = lead.stage;
    const fromStageId = lead.pipelineStageId;
    const enteredAt = lead.pipelineStageAt || lead.stageChangedAt || lead.createdAt;
    if (body.pipelineStageId || body.pipelineId) {
      // A move on the board (D84): to a stage of the lead's pipeline, or into another pipeline.
      const fromPipeline = await pipelineService.pipelineOfLead(lead, session);
      const toPipeline = body.pipelineId ? await pipelineService.findOwn(req, body.pipelineId, session) : fromPipeline;
      const target = body.pipelineStageId ? pipelineService.findStage(toPipeline, body.pipelineStageId) : pipelineService.stageForKind(toPipeline, ['Won', 'Lost'].includes(lead.stage) ? 'New' : lead.stage);
      if (!target) throw httpError(400, 'STAGE_NOT_IN_PIPELINE', `That stage is not in the "${toPipeline.name}" pipeline. Reload the board and try again.`);
      const fromStage = pipelineService.effectiveStage(fromPipeline, fromStageId, from);
      const samePlace = String(fromPipeline._id) === String(toPipeline._id) && fromStage && String(fromStage._id) === String(target._id) && lead.stage === target.kind;
      if (!samePlace) {
        if (applyStage(lead, target.kind)) stageChange = { from, to: lead.stage };
        await pipelineService.recordMove(req, lead, { pipeline: fromPipeline, stage: fromStage, kind: from }, { pipeline: toPipeline, stage: target }, { source: sourceOf(req, source), session, enteredAt });
        Object.assign(lead, { pipelineId: toPipeline._id, pipelineStageId: target._id, pipelineStageAt: new Date(), probability: target.probability });
        boardMove = { from: fromStage?.name || from, to: target.name, fromKind: from, toKind: lead.stage };
      }
    } else if (applyStage(lead, body.stage, body.lostReason)) {
      stageChange = { from, to: lead.stage };
      if (lead.stage === 'Won') await markContactCustomer(req, lead, session);
      await pipelineService.followKind(req, lead, { fromKind: from, fromStageId, source: sourceOf(req, source), session, enteredAt });
    }
    lead.version += 1;
    lead.lastActivityAt = new Date();
    await lead.save({ session });
    if (boardMove) {
      await addActivity(req, lead, 'Stage changed', `${boardMove.from} → ${boardMove.to}`, { meta: { from: boardMove.fromKind, to: boardMove.toKind, fromStage: boardMove.from, toStage: boardMove.to }, session });
    } else if (stageChange) {
      await addActivity(req, lead, 'Stage changed', `${stageChange.from} → ${stageChange.to}`, { meta: stageChange, session });
    } else {
      await addActivity(req, lead, 'Lead updated', 'Lead details updated', { session });
    }
  });
  await audit(req, { action: stageChange || boardMove ? 'lead.stage_changed' : 'lead.updated', entityType: 'Lead', entityId: id, changes: boardMove || stageChange || Object.keys(body) });
  if (stageChange) await emitStageChange(req, id, stageChange);
  return loadSerialized(req, id);
}

// "A lead changes stage" for the automation engine (after the change is saved).
async function emitStageChange(req, leadId, { from, to }) {
  const lead = await Lead.findById(leadId).select('organizationId contactId source');
  if (lead) automationEvents.emit('lead.stage_changed', { organizationId: lead.organizationId, leadId, contactId: lead.contactId, source: lead.source, from, to }, req);
}

// POST /leads/:id/convert — idempotent: repeating it returns the same lead and contact.
async function convert(req, id) {
  let moved = null;
  await mongoose.connection.transaction(async (session) => {
    moved = null;
    const lead = await findVisible(req, id, session);
    const wasConverted = Boolean(lead.convertedAt);
    const from = lead.stage;
    const fromStageId = lead.pipelineStageId;
    const enteredAt = lead.pipelineStageAt || lead.stageChangedAt || lead.createdAt;
    if (applyStage(lead, 'Won')) await pipelineService.followKind(req, lead, { fromKind: from, fromStageId, source: sourceOf(req, 'convert'), session, enteredAt });
    await markContactCustomer(req, lead, session);
    if (from !== lead.stage || !wasConverted) {
      lead.version += 1;
      await lead.save({ session });
      await addActivity(req, lead, 'Converted', 'Converted to customer', { session });
      if (from !== lead.stage) moved = { from, to: lead.stage };
    }
  });
  if (moved) await emitStageChange(req, id, moved);
  await audit(req, { action: 'lead.converted', entityType: 'Lead', entityId: id });
  return loadSerialized(req, id);
}

async function remove(req, id) {
  const lead = await findVisible(req, id);
  await lead.softDelete();
  await audit(req, { action: 'lead.deleted', entityType: 'Lead', entityId: lead._id });
}

async function listActivities(req, id) {
  const lead = await findVisible(req, id);
  const activities = await LeadActivity.find({ organizationId: lead.organizationId, leadId: lead._id }).sort({ createdAt: -1 }).limit(200);
  const mentioned = [...new Set(activities.flatMap((a) => (a.mentions || []).map(String)))];
  const names = new Map((mentioned.length ? await OrganizationMember.find({ _id: { $in: mentioned }, organizationId: lead.organizationId }).populate('userId', 'name') : [])
    .map((m) => [String(m._id), m.displayName || m.userId?.name || '']));
  return activities.map((activity) => ({
    id: activity._id, type: activity.type, text: activity.text, actorName: activity.actorName, createdAt: activity.createdAt,
    ...(activity.mentions?.length && { mentions: activity.mentions.map((m) => ({ id: m, name: names.get(String(m)) || '' })) }),
  }));
}

// @mentions (D87): only active teammates who can open this deal (its module, and the deal itself
// when they see only their own; private deals only for owners).
const nameOf = (member) => member.displayName || member.userId?.name || 'a teammate';
async function membersWhoSee(lead, members) {
  const seeing = [];
  for (const member of members) {
    if (!MODULES.some((module) => can(member, module, 'view'))) continue;
    const asThem = { tenant: { organizationId: lead.organizationId }, member };
    if (await Lead.exists({ _id: lead._id, organizationId: lead.organizationId, ...visibilityFilter(asThem, MODULES), ...privacyFilter(asThem) })) seeing.push(member);
  }
  return seeing;
}

async function mentionable(req, id, { q = '' } = {}) {
  const lead = await findVisible(req, id);
  const members = await OrganizationMember.find({ organizationId: lead.organizationId, status: 'active', _id: { $ne: req.member._id } }).populate('userId', 'name email').limit(200);
  const words = String(q).trim().toLowerCase();
  const matching = members.filter((m) => !words || nameOf(m).toLowerCase().includes(words) || (m.userId?.email || '').toLowerCase().startsWith(words));
  return (await membersWhoSee(lead, matching)).slice(0, 20).map((m) => ({ id: m._id, name: nameOf(m) }));
}

async function addNote(req, id, { type = 'Note', text, mentions = [] }) {
  const lead = await findVisible(req, id);
  let notify = [];
  if (mentions.length) {
    const members = await OrganizationMember.find({ _id: { $in: mentions }, organizationId: lead.organizationId, status: 'active' }).populate('userId', 'name');
    if (members.length !== mentions.length) throw httpError(422, 'MENTION_UNKNOWN', 'Only active members of your team can be mentioned.');
    const seeing = new Set((await membersWhoSee(lead, members)).map((m) => String(m._id)));
    const blind = members.filter((m) => !seeing.has(String(m._id)));
    if (blind.length) throw httpError(422, 'MENTION_NO_ACCESS', `${blind.map(nameOf).join(', ')} cannot open this deal, so they cannot be mentioned here.`, blind.map((m) => ({ field: 'mentions', code: 'MENTION_NO_ACCESS', message: nameOf(m), memberId: String(m._id) })));
    notify = members.filter((m) => String(m._id) !== String(req.member._id)).map((m) => m._id);
  }
  await LeadActivity.create([{
    organizationId: lead.organizationId,
    leadId: lead._id,
    contactId: lead.contactId?._id || lead.contactId,
    type,
    text,
    actorUserId: req.user._id,
    actorName: req.user.name,
    ...(mentions.length && { mentions }),
  }]);
  await Lead.updateOne({ _id: lead._id }, { lastActivityAt: new Date() });
  if (notify.length) {
    await notificationService.notify(lead.organizationId, notify, {
      title: `${req.user.name} mentioned you on “${lead.title}”`, body: text.slice(0, 300), link: `Deals.html?open=${lead._id}`, source: 'mention',
    });
  }
  return listActivities(req, id);
}

module.exports = {
  list, create, update, convert, remove, listActivities, addNote, mentionable,
  get: loadSerialized,
  changeStage: (req, id, { stage, lostReason, version, pipelineStageId, pipelineId }) => update(req, id, { stage, lostReason, version, pipelineStageId, pipelineId }, { source: 'board' }),
  // GET /leads/:id/stage-history (D84).
  stageHistory: async (req, id) => pipelineService.history(await findVisible(req, id)),
  findVisible, addActivity, applyStage, serializeLead, emitStageChange, MODULES,
  listFilter, listSort: (query) => sortSpec(query.sort, SORTS),
};
