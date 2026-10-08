const AuditLog = require('../models/AuditLog');
const OrganizationMember = require('../models/OrganizationMember');
const { toPage, paginationMeta } = require('../utils/pagination');
const { rangeOf } = require('../utils/reportRange');

// The audit-log viewer (Phase 10F, Settings → Audit log, owners and admins): who did what and
// when — sign-ins, changes to customers, leads, quotations, orders, settings, keys, the plan …
// The entries are written by utils/audit.js (secrets are redacted there) and never changed.
const escape = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function serialize(entry) {
  const actor = entry.actorUserId && entry.actorUserId._id ? entry.actorUserId : null;
  return {
    id: entry._id,
    at: entry.createdAt,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId || '',
    actor: actor ? { id: actor._id, name: actor.name || '', email: actor.email || '' } : null,
    changes: entry.changes ?? null,
    ip: entry.ip || '',
  };
}

// GET /audit-logs?action=&entityType=&actorUserId=&from=&to=&page=&limit=
async function list(req, query) {
  const filter = { organizationId: req.tenant.organizationId };
  if (query.action) filter.action = new RegExp(`^${escape(query.action)}`);
  if (query.entityType) filter.entityType = query.entityType;
  if (query.entityId) filter.entityId = query.entityId;
  if (query.actorUserId) filter.actorUserId = query.actorUserId;
  if (query.from || query.to) {
    const range = rangeOf({ from: query.from, to: query.to });
    filter.createdAt = { $gte: range.start, $lt: range.end };
  }
  const page = toPage(query);
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip(page.skip).limit(page.limit).populate({ path: 'actorUserId', select: 'name email' }),
    AuditLog.countDocuments(filter),
  ]);
  return { items: items.map(serialize), pagination: paginationMeta(page, total) };
}

// GET /audit-logs/meta — what the filters offer: the kinds of action (by area) and the people.
async function meta(req) {
  const organizationId = req.tenant.organizationId;
  const [actions, members] = await Promise.all([
    AuditLog.distinct('action', { organizationId }),
    OrganizationMember.find({ organizationId, deletedAt: { $exists: true } }).populate({ path: 'userId', select: 'name email' }),
  ]);
  const areas = [...new Set(actions.map((action) => action.split('.')[0]))].sort();
  return {
    areas,
    actions: actions.sort(),
    people: members.filter((m) => m.userId).map((m) => ({ userId: m.userId._id, name: m.displayName || m.userId.name || m.userId.email, email: m.userId.email })),
  };
}

module.exports = { list, meta, serialize };
