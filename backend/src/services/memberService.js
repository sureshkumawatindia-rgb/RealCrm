const OrganizationMember = require('../models/OrganizationMember');
const tenantRepository = require('../repositories/tenantRepository');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { revokeMemberSessions } = require('./sessionService');
const bus = require('../realtime/bus');

const MANAGER_ROLES = ['owner', 'admin'];

function serializeMember(member) {
  const user = member.userId && typeof member.userId === 'object' && member.userId.email ? member.userId : null;
  return {
    id: member._id,
    userId: user ? user._id : member.userId,
    name: member.displayName || user?.name || '',
    email: user?.email || '',
    picture: user?.picture || '',
    role: member.role,
    modules: member.modules,
    permissions: member.permissions,
    status: member.status,
    mobile: member.mobile,
    title: member.title,
    assignable: member.assignable,
    joinedAt: member.createdAt,
  };
}

async function list(req, pageQuery) {
  const repo = tenantRepository(OrganizationMember, req.tenant.organizationId);
  const { items, pagination } = await repo.paginate({}, pageQuery, {
    sort: { createdAt: 1 },
    populate: { path: 'userId', select: 'name email picture' },
  });
  return { items: items.map(serializeMember), pagination };
}

async function findInOrg(req, id) {
  const member = await tenantRepository(OrganizationMember, req.tenant.organizationId)
    .findById(id).populate({ path: 'userId', select: 'name email picture' });
  if (!member) throw httpError(404, 'NOT_FOUND', 'Member not found');
  return member;
}

async function assertAnotherOwner(req, member) {
  const owners = await tenantRepository(OrganizationMember, req.tenant.organizationId)
    .count({ role: 'owner', status: 'active', _id: { $ne: member._id } });
  if (owners === 0) throw httpError(409, 'LAST_OWNER', 'An organization needs at least one active owner.');
}

// Rules: nobody changes their own role/status; only owners touch owners and admins;
// the last active owner cannot be demoted, disabled or removed.
async function update(req, id, patch) {
  const member = await findInOrg(req, id);
  const isSelf = String(member._id) === String(req.member._id);
  if (isSelf && ('role' in patch || 'status' in patch)) {
    throw httpError(403, 'FORBIDDEN', 'You cannot change your own role or status.');
  }
  const touchesManagers = MANAGER_ROLES.includes(member.role) || MANAGER_ROLES.includes(patch.role);
  if (touchesManagers && req.member.role !== 'owner') {
    throw httpError(403, 'FORBIDDEN', 'Only an owner can change owners and admins.');
  }
  const losesOwner = member.role === 'owner' && ((patch.role && patch.role !== 'owner') || patch.status === 'disabled');
  if (losesOwner) await assertAnotherOwner(req, member);

  const before = { role: member.role, modules: member.modules, permissions: member.permissions, status: member.status };
  Object.assign(member, patch);
  await member.save();
  if (patch.status === 'disabled') await revokeMemberSessions(member.userId._id || member.userId, member.organizationId);
  // Live connections (inbox) reconnect with the new access, or are refused.
  bus.emit('member:access-changed', { memberId: member._id });

  await audit(req, {
    action: 'member.updated',
    entityType: 'OrganizationMember',
    entityId: member._id,
    changes: { before, after: { role: member.role, modules: member.modules, permissions: member.permissions, status: member.status } },
  });
  return serializeMember(member);
}

async function remove(req, id) {
  const member = await findInOrg(req, id);
  if (String(member._id) === String(req.member._id)) throw httpError(403, 'FORBIDDEN', 'You cannot remove yourself.');
  if (MANAGER_ROLES.includes(member.role) && req.member.role !== 'owner') {
    throw httpError(403, 'FORBIDDEN', 'Only an owner can remove owners and admins.');
  }
  if (member.role === 'owner') await assertAnotherOwner(req, member);

  await member.softDelete();
  await revokeMemberSessions(member.userId._id || member.userId, member.organizationId);
  bus.emit('member:access-changed', { memberId: member._id });
  await audit(req, { action: 'member.removed', entityType: 'OrganizationMember', entityId: member._id, changes: { role: member.role } });
}

module.exports = { list, update, remove, serializeMember };
