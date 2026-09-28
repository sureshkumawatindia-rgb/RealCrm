const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { toPage, paginationMeta } = require('../utils/pagination');
const { searchFilter, sortSpec } = require('../utils/listQuery');
const { visibilityFilter, resolveOwnerId, ownerPatch } = require('./access');

// Shared by campaigns, workflows and sequences: records with an owner (D17: agents and viewers
// see what they own unless they have view_all; only owners/admins pick another owner).
// config: { Model, modules, entityType, label, fields, searchFields, sorts, defaultSort,
//           filters(query) → mongo filter, prepare?(record) → validate before save, serialize }
function createOwnedRecordService(config) {
  const { Model, modules, entityType, label, fields, searchFields, sorts, defaultSort, filters, prepare, serialize } = config;
  const action = (verb) => `${entityType.toLowerCase()}.${verb}`;

  async function findVisible(req, id) {
    const record = await Model.findOne({ _id: id, organizationId: req.tenant.organizationId, ...visibilityFilter(req, modules) });
    if (!record) throw httpError(404, 'NOT_FOUND', `${label} not found`);
    return record;
  }

  function apply(record, body) {
    for (const key of fields) {
      if (!(key in body)) continue;
      // "" clears an optional calendar day.
      record.set(key, body[key] === '' && /Date$/.test(key) ? undefined : body[key]);
    }
    if (prepare) prepare(record);
  }

  async function list(req, query) {
    const conditions = [visibilityFilter(req, modules), searchFilter(query.q, searchFields)].filter((condition) => Object.keys(condition).length);
    const filter = { organizationId: req.tenant.organizationId, ...filters(query), ...(conditions.length && { $and: conditions }) };
    const page = toPage(query);
    const [items, total] = await Promise.all([
      Model.find(filter).sort(sortSpec(query.sort, sorts, defaultSort)).skip(page.skip).limit(page.limit),
      Model.countDocuments(filter),
    ]);
    return { items: items.map(serialize), pagination: paginationMeta(page, total) };
  }

  async function create(req, body) {
    const record = new Model({
      organizationId: req.tenant.organizationId,
      ownerId: await resolveOwnerId(req, body.ownerId),
      createdById: req.user._id,
      createdByMemberId: req.member._id,
    });
    apply(record, body);
    await record.save();
    await audit(req, { action: action('created'), entityType, entityId: record._id });
    return serialize(record);
  }

  async function update(req, id, body) {
    const record = await findVisible(req, id);
    apply(record, body);
    Object.assign(record, await ownerPatch(req, body));
    await record.save();
    await audit(req, { action: action('updated'), entityType, entityId: record._id, changes: Object.keys(body) });
    return serialize(record);
  }

  async function remove(req, id) {
    const record = await findVisible(req, id);
    await record.softDelete();
    await audit(req, { action: action('deleted'), entityType, entityId: record._id });
  }

  return {
    list, create, update, remove, findVisible,
    get: async (req, id) => serialize(await findVisible(req, id)),
  };
}

module.exports = { createOwnedRecordService };
