const CustomRecord = require('../models/CustomRecord');
const tenantRepository = require('../repositories/tenantRepository');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { escapeRegex, sortSpec } = require('../utils/listQuery');
const { visibilityFilter, resolveOwnerId, ownerPatch } = require('./access');
const customFieldService = require('./customFieldService');
const customFieldFilters = require('./customFieldFilters');
const customObjectService = require('./customObjectService');
const lookupService = require('./lookupService');
const automationEvents = require('./automation/events');

// Records of the company's own objects (Phase 1C, D75). They follow the Customers module: the
// same view / create / edit / delete, and agents see the records they own unless they have
// customers:view_all. A record may belong to a customer (contactId): it then shows on that
// customer's Customer 360.

const MODULE = 'customers';
const SORTS = ['name', 'createdAt', 'updatedAt'];
const repo = (req) => tenantRepository(CustomRecord, req.tenant.organizationId);
const invalidContact = () => httpError(400, 'VALIDATION_ERROR', 'Pick a customer from the list.', [{ field: 'contactId', code: 'INVALID_LINK', message: 'Pick a customer from the list.' }]);

function serialize(record, { keys, links, contacts }) {
  const contactId = record.contactId ? String(record.contactId) : null;
  return {
    id: record._id,
    object: record.object,
    name: record.name,
    contactId,
    contact: contactId ? contacts?.get(contactId) || { id: contactId, missing: true } : null,
    ownerId: record.ownerId || null,
    customFields: customFieldService.visibleValues(record.customFields, keys),
    customFieldLinks: links?.get(String(record._id)) || {},
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// Records (of any objects) with their visible values, link names and customer names.
async function present(req, records) {
  const objects = [...new Set(records.map((r) => r.object))];
  const [perObject, contacts] = await Promise.all([
    Promise.all(objects.map(async (object) => {
      const docs = records.filter((r) => r.object === object);
      const [keys, links] = await Promise.all([customFieldService.activeKeys(req, object), lookupService.linksFor(req, object, docs)]);
      return [object, { keys, links }];
    })),
    lookupService.resolve(req, 'contact', records.map((r) => r.contactId).filter(Boolean)),
  ]);
  const byObject = new Map(perObject);
  return records.map((record) => serialize(record, { ...byObject.get(record.object), contacts }));
}

// GET /records?object=… (one object) or ?contactId=… (a customer's records of every active object).
async function list(req, query) {
  const active = await customObjectService.activeObjects(req);
  const activeKeys = active.map((o) => o.key);
  if (query.object && !activeKeys.includes(query.object)) throw httpError(404, 'NOT_FOUND', 'Object not found');
  const term = String(query.q || '').trim();
  const [extraSearch, fieldFilters] = await Promise.all([
    query.object && term ? customFieldFilters.searchClauses(req, query.object, term) : [],
    query.object ? customFieldFilters.conditions(req, query.object, query.cf) : [],
  ]);
  if (!query.object && query.cf?.length) throw httpError(400, 'VALIDATION_ERROR', 'Choose an object to filter its fields.', [{ field: 'cf', code: 'INVALID_FILTER', message: 'Choose an object to filter its fields.' }]);
  const filter = {
    object: query.object || { $in: activeKeys },
    ...(query.contactId && { contactId: query.contactId }),
    ...(term && { $or: [{ name: new RegExp(escapeRegex(term.slice(0, 100)), 'i') }, ...extraSearch] }),
    ...(fieldFilters.length && { $and: fieldFilters }),
    ...visibilityFilter(req, MODULE),
  };
  const { items, pagination } = await repo(req).paginate(filter, query, { sort: sortSpec(query.sort, SORTS, { updatedAt: -1 }) });
  return { items: await present(req, items), pagination };
}

// Global search: the name, and the text fields of every active object.
async function searchAll(req, { q, limit = 5 }) {
  const term = String(q || '').trim();
  const active = await customObjectService.activeObjects(req);
  if (!term || !active.length) return { items: [], pagination: { total: 0 } };
  const perObject = await Promise.all(active.map(async (o) => {
    const clauses = await customFieldFilters.searchClauses(req, o.key, term);
    return clauses.length ? { object: o.key, $or: clauses } : null;
  }));
  const filter = {
    object: { $in: active.map((o) => o.key) },
    $or: [{ name: new RegExp(escapeRegex(term.slice(0, 100)), 'i') }, ...perObject.filter(Boolean)],
    ...visibilityFilter(req, MODULE),
  };
  const { items, pagination } = await repo(req).paginate(filter, { page: 1, limit }, { sort: { updatedAt: -1 } });
  const names = new Map(active.map((o) => [o.key, o.singular]));
  return { items: (await present(req, items)).map((r) => ({ ...r, objectName: names.get(r.object) })), pagination };
}

async function findVisible(req, id) {
  const record = await repo(req).findOne({ _id: id, ...visibilityFilter(req, MODULE) });
  if (!record) throw httpError(404, 'NOT_FOUND', 'Record not found');
  // Records of an archived object are hidden with it (D75).
  await customObjectService.findActive(req, record.object);
  return record;
}

async function create(req, body, { enforceRequired = true } = {}) {
  await customObjectService.findActive(req, body.object);
  if (body.contactId && !(await lookupService.check(req, 'contact', body.contactId))) throw invalidContact();
  const customFields = body.customFields === undefined
    ? undefined
    : await customFieldService.applyValues(req, body.object, body.customFields, undefined, { isNew: true, enforceRequired });
  const record = await repo(req).create({
    object: body.object,
    name: body.name,
    contactId: body.contactId || undefined,
    ownerId: await resolveOwnerId(req, body.ownerId),
    customFields,
    createdById: req.user._id,
  });
  await audit(req, { action: 'record.created', entityType: 'CustomRecord', entityId: record._id, changes: { object: record.object } });
  automationEvents.emit('record.created', { organizationId: record.organizationId, recordId: record._id, object: record.object, key: `record.created:${record._id}` }, req);
  return record;
}

// What a change compares (record.updated is sent only when one of these changed, D78).
const stateOf = (record) => JSON.stringify([record.name, String(record.contactId || ''), String(record.ownerId || ''), record.customFields || {}]);

async function update(req, id, patch, { enforceRequired = true } = {}) {
  const record = await findVisible(req, id);
  if (patch.version !== undefined && patch.version !== record.version) throw httpError(409, 'VERSION_CONFLICT', 'Someone else changed this record. Reload and try again.');
  const before = stateOf(record);
  const changes = [];
  if ('name' in patch) { record.name = patch.name; changes.push('name'); }
  if ('contactId' in patch) {
    // A new customer must be one this member may see; the one it has is kept as it is.
    if (patch.contactId && patch.contactId !== String(record.contactId || '') && !(await lookupService.check(req, 'contact', patch.contactId))) throw invalidContact();
    record.contactId = patch.contactId || undefined;
    changes.push('contactId');
  }
  if (patch.customFields !== undefined) {
    record.customFields = await customFieldService.applyValues(req, record.object, patch.customFields, record.customFields, { enforceRequired });
    record.markModified('customFields');
    changes.push('customFields');
  }
  Object.assign(record, await ownerPatch(req, patch));
  record.version += 1;
  await record.save();
  await audit(req, { action: 'record.updated', entityType: 'CustomRecord', entityId: record._id, changes });
  if (stateOf(record) !== before) {
    automationEvents.emit('record.updated', { organizationId: record.organizationId, recordId: record._id, object: record.object, key: `record.updated:${record._id}:${record.version}` }, req);
  }
  return record;
}

async function remove(req, id) {
  const record = await findVisible(req, id);
  await record.softDelete();
  await audit(req, { action: 'record.deleted', entityType: 'CustomRecord', entityId: record._id });
  // The record is gone from lists by now, so the event carries what identifies it.
  automationEvents.emit('record.deleted', { organizationId: record.organizationId, recordId: record._id, object: record.object, name: record.name, key: `record.deleted:${record._id}` }, req);
}

const one = async (req, record) => (await present(req, [record]))[0];

module.exports = {
  list,
  searchAll,
  get: async (req, id) => one(req, await findVisible(req, id)),
  create: async (req, body) => one(req, await create(req, body)),
  update: async (req, id, patch) => one(req, await update(req, id, patch)),
  remove,
  // The public API (D78) shapes its own answer from the saved record.
  createDoc: create,
  updateDoc: update,
};
