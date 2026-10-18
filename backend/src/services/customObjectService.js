const mongoose = require('mongoose');
const CustomObjectDefinition = require('../models/CustomObjectDefinition');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { can, isManager } = require('../constants/permissions');
const { MAX_CUSTOM_OBJECTS } = require('../constants/customFields');
const customFieldService = require('./customFieldService');

// The company's own objects (Phase 1C, D75): Machines, Sites, AMC contracts … Owners and admins
// manage them in Settings → Custom fields; everyone who can view customers sees the active ones
// (the menu, Customer 360, link fields). Up to 10 active on every plan; archived ones keep their
// records and do not count.

const forbidden = () => httpError(403, 'FORBIDDEN', 'You do not have permission to do this.');
const scope = (req, filter = {}) => ({ ...filter, organizationId: req.tenant.organizationId });
const limitError = () => httpError(422, 'OBJECT_LIMIT', `You can have up to ${MAX_CUSTOM_OBJECTS} objects. Archive one you no longer use first.`);
const conflict = () => httpError(409, 'VERSION_CONFLICT', 'Someone else changed this object. Reload and try again.');

function serialize(o) {
  return {
    id: o._id,
    key: o.key,
    singular: o.singular,
    plural: o.plural,
    icon: o.icon,
    order: o.order,
    status: o.status,
    archivedAt: o.archivedAt || null,
    version: o.version,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

async function findById(req, id, session) {
  const found = await CustomObjectDefinition.findOne(scope(req, { _id: id })).session(session || null);
  if (!found) throw httpError(404, 'NOT_FOUND', 'Object not found');
  return found;
}

// The active object with this key, or 404.
async function findActive(req, key) {
  const found = await CustomObjectDefinition.findOne(scope(req, { key, status: 'active' })).lean();
  if (!found) throw httpError(404, 'NOT_FOUND', 'Object not found');
  return found;
}

const activeObjects = (req) => CustomObjectDefinition.find(scope(req, { status: 'active' })).sort({ order: 1, createdAt: 1 }).lean();

async function list(req, { status = 'active' } = {}) {
  if (!can(req.member, 'customers', 'view')) throw forbidden();
  if (status === 'all' && !isManager(req.member)) throw forbidden();
  const filter = scope(req, status === 'active' ? { status: 'active' } : {});
  return (await CustomObjectDefinition.find(filter).sort({ status: 1, order: 1, createdAt: 1 })).map(serialize);
}

async function create(req, body) {
  let created;
  await mongoose.connection.transaction(async (session) => {
    created = null;
    await customFieldService.takeTurn(req, session); // the limit holds with two admins at once
    const existing = await CustomObjectDefinition.find(scope(req)).select('key status order').session(session);
    if (existing.filter((o) => o.status === 'active').length >= MAX_CUSTOM_OBJECTS) throw limitError();
    const taken = new Set(existing.map((o) => o.key.slice(2)));
    [created] = await CustomObjectDefinition.create([{
      organizationId: req.tenant.organizationId,
      key: `x_${customFieldService.keyFromLabel(body.plural, taken, 'object')}`,
      singular: body.singular,
      plural: body.plural,
      icon: body.icon,
      order: Math.max(-1, ...existing.map((o) => o.order)) + 1,
      createdById: req.user._id,
      updatedById: req.user._id,
    }], { session });
  });
  await audit(req, { action: 'custom_object.created', entityType: 'CustomObjectDefinition', entityId: created._id, changes: { key: created.key } });
  return serialize(created);
}

// Names and icon; the key never changes.
async function update(req, id, body) {
  const found = await findById(req, id);
  if (body.version !== undefined && body.version !== found.version) throw conflict();
  const set = {};
  for (const key of ['singular', 'plural', 'icon']) if (key in body) set[key] = body[key];
  const updated = await CustomObjectDefinition.findOneAndUpdate(
    scope(req, { _id: found._id, version: found.version }),
    { $set: { ...set, updatedById: req.user._id }, $inc: { version: 1 } },
    { returnDocument: 'after', runValidators: true },
  );
  if (!updated) throw conflict();
  await audit(req, { action: 'custom_object.updated', entityType: 'CustomObjectDefinition', entityId: found._id, changes: Object.keys(set) });
  return serialize(updated);
}

// Hides the object everywhere; its records and fields stay. Repeating it is harmless.
async function archive(req, id) {
  const found = await findById(req, id);
  if (found.status === 'archived') return serialize(found);
  const updated = await CustomObjectDefinition.findOneAndUpdate(
    scope(req, { _id: found._id, status: 'active' }),
    { $set: { status: 'archived', archivedAt: new Date(), updatedById: req.user._id }, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
  await audit(req, { action: 'custom_object.archived', entityType: 'CustomObjectDefinition', entityId: found._id });
  return serialize(updated || await findById(req, id));
}

async function restore(req, id) {
  let found;
  let restored = false;
  await mongoose.connection.transaction(async (session) => {
    restored = false;
    await customFieldService.takeTurn(req, session);
    found = await findById(req, id, session);
    if (found.status === 'active') return;
    const active = await CustomObjectDefinition.find(scope(req, { status: 'active' })).select('order').session(session);
    if (active.length >= MAX_CUSTOM_OBJECTS) throw limitError();
    found.set({ status: 'active', archivedAt: undefined, order: Math.max(-1, ...active.map((o) => o.order)) + 1, updatedById: req.user._id });
    found.version += 1;
    await found.save({ session });
    restored = true;
  });
  if (restored) await audit(req, { action: 'custom_object.restored', entityType: 'CustomObjectDefinition', entityId: found._id });
  return serialize(found);
}

// ids: every active object, once each, in the new order.
async function reorder(req, { ids }) {
  const active = await CustomObjectDefinition.find(scope(req, { status: 'active' })).select('_id');
  const activeIds = new Set(active.map((o) => String(o._id)));
  if (ids.length !== activeIds.size || new Set(ids).size !== ids.length || ids.some((id) => !activeIds.has(id))) {
    throw httpError(400, 'VALIDATION_ERROR', 'The list of objects is out of date. Reload and try again.', [{ field: 'ids', code: 'INVALID_ORDER', message: 'List every active object once.' }]);
  }
  await CustomObjectDefinition.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: scope(req, { _id: id }), update: { $set: { order } } } })));
  await audit(req, { action: 'custom_object.reordered', entityType: 'CustomObjectDefinition', changes: { ids } });
  return list(req);
}

module.exports = { list, create, update, archive, restore, reorder, findActive, activeObjects, serialize };
