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
const automationEvents = require('./automation/events');

// Leads are shown on the Leads page and, as a Kanban, on the Deals page (D13).
const MODULES = ['leads', 'deals'];
const EDITABLE = ['title', 'source', 'productId', 'quantity', 'expectedValuePaise', 'expectedCloseDate', 'followUpAt', 'notes', 'noteEntries'];
const SORTS = ['createdAt', 'updatedAt', 'expectedValuePaise', 'expectedCloseDate', 'followUpAt', 'stage', 'title'];
const CONTACT_SELECT = 'name email phone company lifecycle';

function contactSummary(contact) {
  if (!contact || !contact._id) return null;
  return { id: contact._id, name: contact.name, email: contact.email, phone: contact.phone, company: contact.company, lifecycle: contact.lifecycle };
}

function serializeLead(lead) {
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
    convertedAt: lead.convertedAt || null,
    lastActivityAt: lead.lastActivityAt || null,
    version: lead.version,
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
  return serializeLead(lead);
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

async function list(req, query) {
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
  if (query.q) {
    const contacts = await Contact.find({ organizationId, ...searchFilter(query.q, ['name', 'email', 'phone', 'company']) }).select('_id').limit(1000);
    const text = searchFilter(query.q, ['title', 'notes']).$or;
    filter.$or = [...text, { contactId: { $in: contacts.map((contact) => contact._id) } }];
  }
  const page = toPage(query);
  const [items, total] = await Promise.all([
    Lead.find(filter).sort(sortSpec(query.sort, SORTS)).skip(page.skip).limit(page.limit).populate({ path: 'contactId', select: CONTACT_SELECT }),
    Lead.countDocuments(filter),
  ]);
  return { items: items.map(serializeLead), pagination: paginationMeta(page, total) };
}

async function create(req, body) {
  let created;
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
      ownerId: await resolveOwnerId(req, body.ownerId),
      lastActivityAt: new Date(),
      createdById: req.user._id,
    });
    applyStage(lead, body.stage, body.lostReason);
    if (lead.stage === 'Won') await markContactCustomer(req, lead, session);
    await lead.save({ session });
    await addActivity(req, lead, 'Lead created', 'Lead created', { session });
    created = lead;
    return lead._id;
  });
  await audit(req, { action: 'lead.created', entityType: 'Lead', entityId: leadId });
  automationEvents.emit('lead.created', { organizationId: created.organizationId, leadId, contactId: created.contactId, source: created.source || 'Manual', key: `lead.created:${leadId}` }, req);
  return loadSerialized(req, leadId);
}

async function update(req, id, body) {
  let stageChange = null;
  await mongoose.connection.transaction(async (session) => {
    stageChange = null;
    const lead = await findVisible(req, id, session);
    if (body.version !== undefined && body.version !== lead.version) {
      throw httpError(409, 'VERSION_CONFLICT', 'Someone else changed this lead. Reload and try again.');
    }
    if (body.contact && Object.keys(body.contact).length) {
      await contactService.updateContact(req, lead.contactId, body.contact, { session, skipVisibility: true });
    }
    if ('productId' in body) await assertProduct(req, body.productId, session);

    for (const key of EDITABLE) if (key in body) lead[key] = body[key];
    Object.assign(lead, await ownerPatch(req, body));
    const from = lead.stage;
    if (applyStage(lead, body.stage, body.lostReason)) {
      stageChange = { from, to: lead.stage };
      if (lead.stage === 'Won') await markContactCustomer(req, lead, session);
    }
    lead.version += 1;
    lead.lastActivityAt = new Date();
    await lead.save({ session });
    if (stageChange) {
      await addActivity(req, lead, 'Stage changed', `${stageChange.from} → ${stageChange.to}`, { meta: stageChange, session });
    } else {
      await addActivity(req, lead, 'Lead updated', 'Lead details updated', { session });
    }
  });
  await audit(req, { action: stageChange ? 'lead.stage_changed' : 'lead.updated', entityType: 'Lead', entityId: id, changes: stageChange || Object.keys(body) });
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
    applyStage(lead, 'Won');
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
  return activities.map((activity) => ({
    id: activity._id, type: activity.type, text: activity.text, actorName: activity.actorName, createdAt: activity.createdAt,
  }));
}

async function addNote(req, id, { type = 'Note', text }) {
  const lead = await findVisible(req, id);
  await addActivity(req, lead, type, text);
  await Lead.updateOne({ _id: lead._id }, { lastActivityAt: new Date() });
  return listActivities(req, id);
}

module.exports = {
  list, create, update, convert, remove, listActivities, addNote,
  get: loadSerialized,
  changeStage: (req, id, { stage, lostReason, version }) => update(req, id, { stage, lostReason, version }),
  findVisible, addActivity, applyStage, serializeLead, emitStageChange, MODULES,
};
