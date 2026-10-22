const BoardView = require('../models/BoardView');
const CustomFieldDefinition = require('../models/CustomFieldDefinition');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { can, isManager } = require('../constants/permissions');
const { BOARD_OBJECTS, BOARD_LAYOUTS, MAX_VIEWS_PER_MEMBER, MAX_SHARED_VIEWS, MAX_BOARD_ITEMS } = require('../constants/boards');
const schemas = require('../validators/boards');
const leadService = require('./leadService');
const taskService = require('./taskService');

// Boards (Phase 7B, D87): saved views of leads or tasks — a table with chosen columns, a Kanban
// board grouped by a field, or a calendar on a date. A view is its maker's; a shared view is the
// team's (members who can open its module). Records are read through the lead and task lists,
// so visibility, private records and masked phones apply as everywhere else.
const invalid = (field, message, code = 'INVALID') => httpError(400, 'VALIDATION_ERROR', message, [{ field, code, message }]);
const PAGE = 100;

const canSee = (req, object) => BOARD_OBJECTS[object].modules.some((module) => can(req.member, module, 'view'));
const objectsOf = (req) => Object.keys(BOARD_OBJECTS).filter((object) => canSee(req, object));

async function customFieldsOf(req, object) {
  if (!BOARD_OBJECTS[object].customFields) return [];
  const fields = await CustomFieldDefinition.find({ organizationId: req.tenant.organizationId, object, status: 'active' }).select('key label type').sort({ order: 1, createdAt: 1 }).lean();
  return fields.map((f) => ({ key: `cf.${f.key}`, label: f.label, type: f.type }));
}

// GET /boards/meta: per object the member can open, what a view may use.
async function meta(req) {
  const objects = {};
  for (const object of objectsOf(req)) {
    const spec = BOARD_OBJECTS[object];
    objects[object] = {
      fields: [...spec.fields.map((key) => ({ key })), ...(await customFieldsOf(req, object))],
      defaultColumns: spec.defaultColumns,
      groupBy: spec.groupBy,
      dateFields: spec.dateFields,
      sorts: spec.sorts,
    };
  }
  return { objects, layouts: BOARD_LAYOUTS, limits: { views: MAX_VIEWS_PER_MEMBER, shared: MAX_SHARED_VIEWS, items: MAX_BOARD_ITEMS } };
}

function serialize(req, view, customKeys = null) {
  const mine = String(view.ownerMemberId) === String(req.member._id);
  const known = (key) => !key.startsWith('cf.') || !customKeys || customKeys.has(key);
  return {
    id: view._id,
    object: view.object,
    name: view.name,
    layout: view.layout,
    filters: view.filters || {},
    // A company field that was removed since is left out.
    columns: (view.columns || []).filter(known),
    groupBy: known(view.groupBy || '') ? view.groupBy : '',
    dateField: view.dateField,
    sort: view.sort,
    shared: view.shared,
    mine,
    canEdit: mine || (view.shared && isManager(req.member)),
    ownerMemberId: view.ownerMemberId,
    updatedAt: view.updatedAt,
  };
}

// Checks a view's settings against its object; gives back the cleaned values.
async function clean(req, object, body) {
  const spec = BOARD_OBJECTS[object];
  const custom = await customFieldsOf(req, object);
  const fieldKeys = new Set([...spec.fields, ...custom.map((f) => f.key)]);
  const out = {};
  if (body.name !== undefined) out.name = body.name;
  if (body.layout !== undefined) out.layout = body.layout;
  if (body.shared !== undefined) out.shared = body.shared;
  if (body.columns !== undefined) {
    const unknown = body.columns.find((key) => !fieldKeys.has(key));
    if (unknown) throw invalid('columns', `"${unknown}" is not a field of this board.`, 'UNKNOWN_COLUMN');
    out.columns = body.columns;
  }
  if (body.groupBy !== undefined) {
    if (body.groupBy && !spec.groupBy.includes(body.groupBy)) throw invalid('groupBy', `A ${object} board cannot be grouped by "${body.groupBy}".`, 'UNKNOWN_GROUP');
    out.groupBy = body.groupBy;
  }
  if (body.dateField !== undefined) {
    if (body.dateField && !spec.dateFields.includes(body.dateField)) throw invalid('dateField', `"${body.dateField}" is not a date of this board.`, 'UNKNOWN_DATE');
    out.dateField = body.dateField;
  }
  if (body.sort !== undefined) {
    const key = String(body.sort).replace(/^-/, '');
    if (body.sort && !spec.sorts.includes(key)) throw invalid('sort', `This board cannot be sorted by "${body.sort}".`, 'UNKNOWN_SORT');
    out.sort = body.sort;
  }
  if (body.filters !== undefined) {
    const { error, value } = schemas.FILTERS[object].validate(body.filters, { stripUnknown: true });
    if (error) throw invalid('filters', error.message.replace(/"/g, ''), 'INVALID_FILTER');
    out.filters = value;
  }
  return out;
}

async function findVisible(req, id) {
  const view = await BoardView.findOne({ _id: id, organizationId: req.tenant.organizationId, $or: [{ ownerMemberId: req.member._id }, { shared: true }] });
  if (!view || !canSee(req, view.object)) throw httpError(404, 'NOT_FOUND', 'Board not found');
  return view;
}

async function customKeysFor(req, objects) {
  const keys = new Set();
  for (const object of objects) (await customFieldsOf(req, object)).forEach((f) => keys.add(f.key));
  return keys;
}

async function list(req, { object } = {}) {
  const objects = objectsOf(req).filter((o) => !object || o === object);
  const views = await BoardView.find({
    organizationId: req.tenant.organizationId,
    object: { $in: objects },
    $or: [{ ownerMemberId: req.member._id }, { shared: true }],
  }).sort({ object: 1, name: 1 });
  const keys = await customKeysFor(req, objects);
  return views.map((view) => serialize(req, view, keys));
}

async function get(req, id) {
  const view = await findVisible(req, id);
  return serialize(req, view, await customKeysFor(req, [view.object]));
}

async function create(req, body) {
  if (!canSee(req, body.object)) throw httpError(403, 'FORBIDDEN', 'You cannot open this kind of record.');
  const organizationId = req.tenant.organizationId;
  if (await BoardView.countDocuments({ organizationId, ownerMemberId: req.member._id }) >= MAX_VIEWS_PER_MEMBER) {
    throw httpError(422, 'BOARD_LIMIT', `You can keep up to ${MAX_VIEWS_PER_MEMBER} boards. Delete one first.`);
  }
  if (body.shared && await BoardView.countDocuments({ organizationId, shared: true }) >= MAX_SHARED_VIEWS) {
    throw httpError(422, 'SHARED_BOARD_LIMIT', `The team can share up to ${MAX_SHARED_VIEWS} boards. Delete one first.`);
  }
  const spec = BOARD_OBJECTS[body.object];
  const values = await clean(req, body.object, body);
  const view = await BoardView.create({
    organizationId,
    object: body.object,
    layout: 'table',
    columns: spec.defaultColumns,
    groupBy: spec.groupBy[0],
    dateField: spec.dateFields[0],
    ...values,
    ownerMemberId: req.member._id,
    createdById: req.user._id,
  });
  await audit(req, { action: 'board.created', entityType: 'BoardView', entityId: view._id, changes: { name: view.name, object: view.object, shared: view.shared } });
  return serialize(req, view);
}

async function editable(req, id) {
  const view = await findVisible(req, id);
  if (!serialize(req, view).canEdit) throw httpError(403, 'FORBIDDEN', 'Only its maker (or an owner or admin, for a shared board) can change this board.');
  return view;
}

async function update(req, id, body) {
  const view = await editable(req, id);
  if (body.shared && !view.shared && await BoardView.countDocuments({ organizationId: req.tenant.organizationId, shared: true }) >= MAX_SHARED_VIEWS) {
    throw httpError(422, 'SHARED_BOARD_LIMIT', `The team can share up to ${MAX_SHARED_VIEWS} boards. Delete one first.`);
  }
  Object.assign(view, await clean(req, view.object, body));
  await view.save();
  await audit(req, { action: 'board.updated', entityType: 'BoardView', entityId: view._id, changes: Object.keys(body) });
  return serialize(req, view);
}

async function remove(req, id) {
  const view = await editable(req, id);
  await view.deleteOne();
  await audit(req, { action: 'board.deleted', entityType: 'BoardView', entityId: view._id, changes: { name: view.name } });
}

// GET /boards/:id/items: the records, through the existing lists. A calendar asks for a range
// (from, to) on its date; Kanban and calendar read up to MAX_BOARD_ITEMS, a table pages by 100.
const DATE_PARAMS = {
  lead: { followUpAt: ['followUpFrom', 'followUpTo'], expectedCloseDate: ['closeFrom', 'closeTo'], createdAt: ['createdFrom', 'createdTo'] },
  task: { dueDate: ['dueFrom', 'dueTo'], createdAt: ['createdFrom', 'createdTo'] },
};
const dayOf = (date) => new Date(date.getTime() + 330 * 60000).toISOString().slice(0, 10);

async function items(req, id, { from, to, page = 1 }) {
  const view = await findVisible(req, id);
  const f = view.filters || {};
  const me = String(req.member._id);
  const query = view.object === 'lead'
    ? { q: f.q, stages: f.stages, sources: f.sources, ownerId: f.ownerId === 'me' ? me : f.ownerId }
    : { q: f.q, statuses: f.statuses, priorities: f.priorities, assigneeId: f.assigneeId === 'me' ? me : f.assigneeId };
  if (view.sort) query.sort = view.sort;
  if (view.layout === 'calendar') {
    if (!from || !to) throw invalid('from', 'A calendar needs from and to.', 'RANGE_REQUIRED');
    const [fromKey, toKey] = DATE_PARAMS[view.object][view.dateField] || [];
    // Task due dates are calendar days; the others are times.
    const asParam = (date) => (view.object === 'task' && view.dateField === 'dueDate' ? dayOf(date) : date);
    if (fromKey) Object.assign(query, { [fromKey]: asParam(from), [toKey]: asParam(to) });
  }
  const service = view.object === 'lead' ? leadService : taskService;
  const all = view.layout !== 'table';
  const collected = [];
  let total = 0;
  for (let p = all ? 1 : page; ; p += 1) {
    const result = await service.list(req, { ...query, page: p, limit: PAGE });
    collected.push(...result.items);
    total = result.pagination.total;
    if (!all || collected.length >= Math.min(total, MAX_BOARD_ITEMS)) break;
  }
  return { view: serialize(req, view), items: collected.slice(0, all ? MAX_BOARD_ITEMS : PAGE), total, page: all ? 1 : page, truncated: all && total > MAX_BOARD_ITEMS };
}

module.exports = { meta, list, get, create, update, remove, items };
