const User = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const Session = require('../models/Session');
const { verifyAccessToken } = require('../utils/tokens');
const httpError = require('../utils/httpError');
const phoneVisibility = require('../services/phoneVisibility');

const ENDED = new Set(['logout', 'reuse', 'removed']);
const SEEN_EVERY_MS = 60 * 1000;

function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

// Verifies the access token and loads the user and their membership in the token's organization.
// Sets req.user, req.member, req.sessionId and req.tenant ({ organizationId, memberId, userId, role }).
async function authenticate(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) throw httpError(401, 'UNAUTHENTICATED', 'Authentication required');

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (error) {
      if (error.name === 'TokenExpiredError') throw httpError(401, 'TOKEN_EXPIRED', 'Your session expired. Please sign in again.');
      throw httpError(401, 'INVALID_AUTHENTICATION', 'Invalid or expired authentication token');
    }

    const [user, member, session] = await Promise.all([
      User.findById(payload.sub),
      OrganizationMember.findOne({ organizationId: payload.org, userId: payload.sub, status: 'active' }),
      Session.findById(payload.sid).select('revokedReason').lean(),
    ]);
    if (!user || user.disabledAt) throw httpError(401, 'USER_NOT_REGISTERED', 'Authenticated user is not registered');
    if (!member) throw httpError(401, 'MEMBERSHIP_REVOKED', 'You no longer have access to this organization.');
    // Logged out (here, or from "Where you're logged in" on another device): at once, not when
    // the 15-minute token runs out. A rotated session is fine — its newer token is in this tab.
    if (!session || ENDED.has(session.revokedReason)) throw httpError(401, 'SESSION_ENDED', 'You were logged out on this device. Please log in again.');

    // "Online" on the live team page (D61): written at most once a minute, never waited for.
    if (!member.lastSeenAt || Date.now() - member.lastSeenAt.getTime() > SEEN_EVERY_MS) {
      OrganizationMember.updateOne({ _id: member._id }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
    }
    req.user = user;
    req.member = member;
    req.sessionId = payload.sid;
    req.tenant = { organizationId: member.organizationId, memberId: member._id, userId: user._id, role: member.role };
    // Agents and viewers get customers' numbers masked in every answer (D65, app.js).
    req.maskPhones = await phoneVisibility.hidesPhonesFor(member);
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { authenticate };
