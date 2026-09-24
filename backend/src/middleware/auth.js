const User = require('../models/User');
const OrganizationMember = require('../models/OrganizationMember');
const { verifyAccessToken } = require('../utils/tokens');
const httpError = require('../utils/httpError');

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

    const [user, member] = await Promise.all([
      User.findById(payload.sub),
      OrganizationMember.findOne({ organizationId: payload.org, userId: payload.sub, status: 'active' }),
    ]);
    if (!user || user.disabledAt) throw httpError(401, 'USER_NOT_REGISTERED', 'Authenticated user is not registered');
    if (!member) throw httpError(401, 'MEMBERSHIP_REVOKED', 'You no longer have access to this organization.');

    req.user = user;
    req.member = member;
    req.sessionId = payload.sid;
    req.tenant = { organizationId: member.organizationId, memberId: member._id, userId: user._id, role: member.role };
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { authenticate };
