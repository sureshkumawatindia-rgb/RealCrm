const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { toPage, paginationMeta } = require('../utils/pagination');
const { searchFilter, sortSpec } = require('../utils/listQuery');
const { assignedOrCreatedFilter, resolveAssigneeId } = require('./access');

// Shared by tasks, calendar events and tickets: each is assigned to a member; tasks and events
// may point at a customer, lead, deal or company ("related"). The related name is kept as a snapshot so
// the item still reads well if the record is renamed or deleted later.
const RELATED_KEYS = ['relatedType', 'relatedId', 'relatedName'];

async function resolveRelated(req, { relatedType = '', relatedId, relatedName = '' }) {
  if (!relatedType) return { relatedType: '', relatedId: undefined, relatedName: '' };
  if (!relatedId || relatedType === 'Account') return { relatedType, relatedId: undefined, relatedName };

  const organizationId = req.tenant.organizationId;
  let name = null;
  if (relatedType === 'Customer' || relatedType === 'Contact') {
    const contact = await Contact.findOne({ _id: relatedId, organizationId }).select('name');
    name = contact?.name;
  } else {
    const lead = await Lead.findOne({ _id: relatedId, organizationId }).populate({ path: 'contactId', select: 'name' });
    name = lead && (relatedType === 'Deal' ? lead.title || lead.contactId?.name : lead.contactId?.name || lead.title);
  }
  if (name == null) {
    throw httpError(400, 'VALIDATION_ERROR', `Unknown ${relatedType.toLowerCase()}.`, [{ field: 'relatedId', code: 'INVALID_RELATED', message: 'Pick an existing record.' }]);
  }
  return { relatedType, relatedId, relatedName: name };
}

// config: { Model, modules, entityType, label, fields, searchFields, sorts, defaultSort,
//           filters(query) → mongo filter, prepare(item) → validate/derive before save, serialize,
//           resolve?(req, item, body) → async lookups of other fields, beforeCreate?(req, item) }
function createWorkItemService(config) {
  const { Model, modules, entityType, label, fields, searchFields, sorts, defaultSort, filters, prepare, serialize, resolve, beforeCreate } = config;

  const baseFilter = (req) => ({ organizationId: req.tenant.organizationId });

  async function findVisible(req, id) {
    const item = await Model.findOne({ _id: id, ...baseFilter(req), ...assignedOrCreatedFilter(req, modules) });
    if (!item) throw httpError(404, 'NOT_FOUND', `${label} not found`);
    return item;
  }

  async function list(req, query) {
    const conditions = [assignedOrCreatedFilter(req, modules), searchFilter(query.q, searchFields)].filter((condition) => Object.keys(condition).length);
    const filter = { ...baseFilter(req), ...filters(query), ...(conditions.length && { $and: conditions }) };
    const page = toPage(query);
    const [items, total] = await Promise.all([
      Model.find(filter).sort(sortSpec(query.sort, sorts, defaultSort)).skip(page.skip).limit(page.limit),
      Model.countDocuments(filter),
    ]);
    return { items: items.map(serialize), pagination: paginationMeta(page, total) };
  }

  async function apply(req, item, body) {
    for (const key of fields) if (key in body) item.set(key, body[key]);
    if ('dueDate' in body && !body.dueDate) item.dueDate = undefined; // "" clears the due date
    if ('assigneeId' in body) {
      item.assigneeId = await resolveAssigneeId(req, body.assigneeId);
      if (item.assigneeId) item.assigneeName = '';
    }
    if (RELATED_KEYS.some((key) => key in body)) {
      const related = await resolveRelated(req, {
        relatedType: 'relatedType' in body ? body.relatedType : item.relatedType,
        relatedId: 'relatedId' in body ? body.relatedId : item.relatedId,
        relatedName: 'relatedName' in body ? body.relatedName : item.relatedName,
      });
      Object.assign(item, related);
    }
    if (resolve) await resolve(req, item, body);
    prepare(item);
  }

  async function create(req, body) {
    const item = new Model({ ...baseFilter(req), createdById: req.user._id, createdByMemberId: req.member._id });
    await apply(req, item, body);
    if (beforeCreate) await beforeCreate(req, item);
    await item.save();
    await audit(req, { action: `${entityType.toLowerCase()}.created`, entityType, entityId: item._id });
    return serialize(item);
  }

  async function update(req, id, body) {
    const item = await findVisible(req, id);
    await apply(req, item, body);
    await item.save();
    await audit(req, { action: `${entityType.toLowerCase()}.updated`, entityType, entityId: item._id, changes: Object.keys(body) });
    return serialize(item);
  }

  async function remove(req, id) {
    const item = await findVisible(req, id);
    await item.softDelete();
    await audit(req, { action: `${entityType.toLowerCase()}.deleted`, entityType, entityId: item._id });
  }

  return {
    list, create, update, remove, findVisible,
    get: async (req, id) => serialize(await findVisible(req, id)),
  };
}

module.exports = { createWorkItemService, resolveRelated };
