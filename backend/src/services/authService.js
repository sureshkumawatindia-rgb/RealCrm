const mongoose = require('mongoose');
const User = require('../models/User');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Session = require('../models/Session');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { signAccessToken } = require('../utils/tokens');
const { verifyGoogleIdToken } = require('../integrations/google/idToken');
const sessionService = require('./sessionService');
const inviteService = require('./inviteService');
const planService = require('./planService');

function safeGoogleAuthMessage(error) {
  const message = String(error.message || '');
  if (/token used too early|issued in the future|iat/i.test(message)) {
    return 'Google token rejected because the server clock is not synchronized. Synchronize the server time and try again.';
  }
  if (/expired|exp/i.test(message)) return 'Google token expired. Start Google sign-in again.';
  if (/audience|azp|client/i.test(message)) return 'Google token audience does not match this application. Check the configured Google client ID.';
  if (/issuer|iss/i.test(message)) return 'Google token issuer is not trusted.';
  if (/segment|jwt|token/i.test(message)) return 'Google returned an invalid authentication token.';
  return 'Google authentication failed. Please try again.';
}

const activeMemberships = (userId) => OrganizationMember.find({ userId, status: 'active' }).sort({ createdAt: 1 });

// Users who signed up before memberships existed own the organization on their user record.
async function adoptLegacyOrganization(user) {
  if (!user.organizationId) return false;
  const organization = await Organization.findById(user.organizationId);
  if (!organization) return false;
  const ownedByUser = !organization.ownerId || String(organization.ownerId) === String(user._id);
  const hasAnyMember = await OrganizationMember.exists({ organizationId: organization._id, ...inviteService.INCLUDING_REMOVED });
  if (!ownedByUser || hasAnyMember) return false;
  await OrganizationMember.create({ organizationId: organization._id, userId: user._id, role: 'owner' });
  return true;
}

async function createOrganizationFor(user) {
  await mongoose.connection.transaction(async (session) => {
    // A new organization starts the 30-day trial (D48).
    const [organization] = await Organization.create([{ name: `${user.name || user.email || 'My'} Organization`, ownerId: user._id, ...planService.trialFields() }], { session });
    await OrganizationMember.create([{ organizationId: organization._id, userId: user._id, role: 'owner' }], { session });
  });
}

async function describeMemberships(userId) {
  const memberships = await activeMemberships(userId).populate({ path: 'organizationId', select: 'name logoUrl' });
  return memberships
    .filter((member) => member.organizationId)
    .map((member) => ({ organizationId: member.organizationId._id, organizationName: member.organizationId.name, role: member.role }));
}

function memberSummary(member) {
  return { id: member._id, role: member.role, modules: member.modules, permissions: member.permissions };
}

async function loginWithGoogle(req, { credential, inviteToken }) {
  let payload;
  try {
    payload = await verifyGoogleIdToken(credential);
  } catch (error) {
    const reason = safeGoogleAuthMessage(error);
    logger.warn(`Google login verification failed: ${reason}`);
    throw httpError(401, 'INVALID_GOOGLE_CREDENTIAL', reason);
  }
  if (!payload?.sub || !payload.email) throw httpError(401, 'INVALID_GOOGLE_CREDENTIAL', 'Google did not return an email address.');
  if (payload.email_verified === false) throw httpError(401, 'INVALID_GOOGLE_CREDENTIAL', 'Verify your Google email address first.');
  const email = payload.email.toLowerCase();

  let user = await User.findOne({ googleId: payload.sub });
  if (!user) {
    user = await User.create({ googleId: payload.sub, email, name: payload.name || email, picture: payload.picture || '' });
  } else {
    user.email = email;
    user.name = payload.name || user.name;
    user.picture = payload.picture || user.picture;
  }
  if (user.disabledAt) throw httpError(403, 'FORBIDDEN', 'This account is disabled.');

  const { invitedOrganizationId, inviteError } = await inviteService.acceptPendingInvites(user, email, inviteToken);
  let memberships = await activeMemberships(user._id);
  if (!memberships.length) {
    if (!(await adoptLegacyOrganization(user))) await createOrganizationFor(user);
    memberships = await activeMemberships(user._id);
  }

  const memberOf = memberships.map((member) => String(member.organizationId));
  const preferred = [invitedOrganizationId, user.organizationId].filter(Boolean).map(String);
  const organizationId = preferred.find((id) => memberOf.includes(id)) || memberOf[0];
  const member = memberships.find((item) => String(item.organizationId) === organizationId);

  user.organizationId = organizationId;
  user.lastLoginAt = new Date();
  await user.save();

  const { session, refreshToken } = await sessionService.createSession({
    userId: user._id, organizationId, userAgent: req.get('user-agent'), ip: req.ip,
  });
  const token = signAccessToken({ userId: user._id, organizationId, sessionId: session._id });
  await audit(req, { organizationId, action: 'auth.login', entityType: 'User', entityId: user._id });

  return {
    refreshToken,
    data: {
      token,
      user: { id: user.googleId, email: user.email, name: user.name, picture: user.picture },
      organizationId,
      member: memberSummary(member),
      memberships: await describeMemberships(user._id),
      ...(inviteError && { inviteError }),
    },
  };
}

// Rotates the refresh token. If the member lost access to the session's organization,
// the session moves to another organization they belong to (or ends).
async function refresh(req, refreshToken) {
  const { session, refreshToken: nextRefreshToken } = await sessionService.rotateSession(refreshToken, {
    userAgent: req.get('user-agent'), ip: req.ip,
  });
  const user = await User.findById(session.userId);
  if (!user || user.disabledAt) {
    await sessionService.revokeFamily(session.familyId, 'logout');
    throw httpError(401, 'USER_NOT_REGISTERED', 'Please sign in again.');
  }

  let member = await OrganizationMember.findOne({ organizationId: session.organizationId, userId: user._id, status: 'active' });
  if (!member) {
    [member] = await activeMemberships(user._id);
    if (!member) {
      await sessionService.revokeFamily(session.familyId, 'removed');
      throw httpError(403, 'NO_MEMBERSHIP', 'You are not a member of any organization. Ask an admin to invite you again.');
    }
    session.organizationId = member.organizationId;
    await session.save();
  }

  const token = signAccessToken({ userId: user._id, organizationId: member.organizationId, sessionId: session._id });
  return { refreshToken: nextRefreshToken, data: { token, organizationId: member.organizationId } };
}

async function logout(refreshToken) {
  await sessionService.revokeByToken(refreshToken, 'logout');
}

async function switchOrganization(req, organizationId) {
  const member = await OrganizationMember.findOne({ organizationId, userId: req.user._id, status: 'active' });
  if (!member) throw httpError(403, 'FORBIDDEN', 'You are not a member of that organization.');
  const session = await Session.findOne({ _id: req.sessionId, userId: req.user._id, revokedAt: null });
  if (!session) throw httpError(401, 'INVALID_AUTHENTICATION', 'Please sign in again.');
  session.organizationId = organizationId;
  await session.save();
  req.user.organizationId = organizationId;
  await req.user.save();

  const token = signAccessToken({ userId: req.user._id, organizationId, sessionId: session._id });
  return { token, organizationId, member: memberSummary(member) };
}

async function me(req) {
  const organization = await Organization.findById(req.tenant.organizationId).select('name logoUrl');
  return {
    user: { id: req.user.googleId, email: req.user.email, name: req.user.name, picture: req.user.picture },
    organization: { id: organization?._id, name: organization?.name || '', logoUrl: organization?.logoUrl || '' },
    member: memberSummary(req.member),
    memberships: await describeMemberships(req.user._id),
  };
}

module.exports = { loginWithGoogle, refresh, logout, switchOrganization, me };
