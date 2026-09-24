const Invite = require('../models/Invite');
const User = require('../models/User');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const tenantRepository = require('../repositories/tenantRepository');
const env = require('../config/env');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { randomToken, hashToken } = require('../utils/tokens');
const { DEFAULT_MODULES } = require('../constants/permissions');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Soft-delete filter that also matches removed members (see models/plugins/softDelete.js).
const INCLUDING_REMOVED = { deletedAt: { $exists: true } };

const inviteLink = (token) => `${env.publicUrl}/crm/frontend/login.html?invite=${encodeURIComponent(token)}`;
const isExpired = (invite) => invite.expiresAt < new Date();

function serializeInvite(invite) {
  return {
    id: invite._id,
    email: invite.email,
    role: invite.role,
    modules: invite.modules,
    permissions: invite.permissions,
    status: invite.status === 'pending' && isExpired(invite) ? 'expired' : invite.status,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
  };
}

async function issue(filter, update) {
  const token = randomToken();
  const invite = await Invite.findOneAndUpdate(
    filter,
    {
      $set: { ...update, tokenHash: hashToken(token), status: 'pending', expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
      $unset: { acceptedAt: 1, acceptedByUserId: 1 },
    },
    { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true },
  );
  return { invite, link: inviteLink(token) };
}

async function create(req, { email, role, modules, permissions }) {
  const { organizationId } = req.tenant;
  if (role === 'admin' && req.member.role !== 'owner') {
    throw httpError(403, 'FORBIDDEN', 'Only an owner can invite admins.');
  }
  const existingUser = await User.findOne({ email });
  if (existingUser && await OrganizationMember.exists({ organizationId, userId: existingUser._id, status: 'active' })) {
    throw httpError(409, 'ALREADY_MEMBER', `${email} is already a member of this organization.`);
  }

  const { invite, link } = await issue(
    { organizationId, email },
    {
      role,
      modules: role === 'admin' || modules?.length ? modules || [] : DEFAULT_MODULES[role],
      permissions: permissions || [],
      invitedById: req.user._id,
    },
  );
  await audit(req, { action: 'invite.created', entityType: 'Invite', entityId: invite._id, changes: { email, role } });
  return { invite: serializeInvite(invite), link };
}

async function list(req, pageQuery, { status = 'pending' } = {}) {
  const repo = tenantRepository(Invite, req.tenant.organizationId);
  const filter = status === 'all' ? {} : { status };
  const { items, pagination } = await repo.paginate(filter, pageQuery);
  return { items: items.map(serializeInvite), pagination };
}

async function findInOrg(req, id) {
  const invite = await tenantRepository(Invite, req.tenant.organizationId).findById(id);
  if (!invite) throw httpError(404, 'NOT_FOUND', 'Invite not found');
  return invite;
}

async function resend(req, id) {
  const existing = await findInOrg(req, id);
  if (existing.status === 'accepted') throw httpError(409, 'CONFLICT', 'This invite was already accepted.');
  if (existing.role === 'admin' && req.member.role !== 'owner') throw httpError(403, 'FORBIDDEN', 'Only an owner can invite admins.');
  const { invite, link } = await issue({ _id: existing._id }, {});
  await audit(req, { action: 'invite.resent', entityType: 'Invite', entityId: invite._id });
  return { invite: serializeInvite(invite), link };
}

async function revoke(req, id) {
  const invite = await findInOrg(req, id);
  if (invite.status === 'accepted') throw httpError(409, 'CONFLICT', 'This invite was already accepted. Remove the member instead.');
  invite.status = 'revoked';
  invite.tokenHash = undefined;
  await invite.save();
  await audit(req, { action: 'invite.revoked', entityType: 'Invite', entityId: invite._id });
  return serializeInvite(invite);
}

// Public: what the login page shows before the invitee signs in.
async function lookup(token) {
  const invite = await Invite.findOne({ tokenHash: hashToken(token) });
  if (!invite || invite.status !== 'pending' || isExpired(invite)) {
    throw httpError(404, 'INVITE_INVALID', 'This invite link is no longer valid. Ask for a new one.');
  }
  const organization = await Organization.findById(invite.organizationId);
  return { organizationName: organization?.name || 'an organization', email: invite.email, role: invite.role, expiresAt: invite.expiresAt };
}

async function accept(invite, user) {
  const member = await OrganizationMember.findOne({ organizationId: invite.organizationId, userId: user._id, ...INCLUDING_REMOVED });
  const grant = { role: invite.role, modules: invite.modules, permissions: invite.permissions, status: 'active', invitedById: invite.invitedById };
  if (!member) {
    await OrganizationMember.create({ organizationId: invite.organizationId, userId: user._id, ...grant });
  } else if (member.deletedAt || member.status !== 'active') {
    Object.assign(member, grant, { deletedAt: null });
    await member.save();
  }
  invite.status = 'accepted';
  invite.acceptedAt = new Date();
  invite.acceptedByUserId = user._id;
  invite.tokenHash = undefined;
  await invite.save();
}

// Called at Google sign-in with the verified email. Accepts every pending invite for that email.
// A bad invite link never blocks the login; the problem is returned for the UI to show.
async function acceptPendingInvites(user, email, inviteToken) {
  let invitedOrganizationId = null;
  let inviteError = null;

  if (inviteToken) {
    const invite = await Invite.findOne({ tokenHash: hashToken(inviteToken) });
    if (!invite || invite.status !== 'pending' || isExpired(invite)) {
      inviteError = { code: 'INVITE_INVALID', message: 'This invite link is no longer valid. Ask for a new one.' };
    } else if (invite.email !== email) {
      inviteError = { code: 'INVITE_EMAIL_MISMATCH', message: `This invite is for ${invite.email}. Sign out and sign in with that Google account.` };
    } else {
      invitedOrganizationId = invite.organizationId;
    }
  }

  const pending = await Invite.find({ email, status: 'pending', expiresAt: { $gt: new Date() } });
  for (const invite of pending) await accept(invite, user);
  return { invitedOrganizationId, inviteError };
}

module.exports = { create, list, resend, revoke, lookup, acceptPendingInvites, serializeInvite, INCLUDING_REMOVED };
