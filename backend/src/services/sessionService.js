const crypto = require('crypto');
const Session = require('../models/Session');
const env = require('../config/env');
const httpError = require('../utils/httpError');
const { randomToken, hashToken } = require('../utils/tokens');

const expiry = () => new Date(Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000);

async function createSession({ userId, organizationId, familyId = crypto.randomUUID(), userAgent = '', ip = '' }) {
  const refreshToken = randomToken();
  const session = await Session.create({
    userId,
    organizationId,
    familyId,
    tokenHash: hashToken(refreshToken),
    expiresAt: expiry(),
    userAgent: String(userAgent).slice(0, 300),
    ip,
  });
  return { session, refreshToken };
}

async function revokeFamily(familyId, reason) {
  await Session.updateMany({ familyId, revokedAt: null }, { revokedAt: new Date(), revokedReason: reason });
}

// Exchanges a refresh token for a new one in the same family. Presenting a token that was
// already rotated or revoked means it leaked (or was replayed): the whole family is revoked.
async function rotateSession(refreshToken, { userAgent = '', ip = '', organizationId } = {}) {
  if (!refreshToken) throw httpError(401, 'INVALID_REFRESH_TOKEN', 'Please sign in again.');
  const tokenHash = hashToken(refreshToken);

  const current = await Session.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: new Date() } },
    { revokedAt: new Date(), revokedReason: 'rotated' },
    { returnDocument: 'after' },
  );
  if (!current) {
    const known = await Session.findOne({ tokenHash });
    if (known?.revokedReason === 'rotated') {
      await revokeFamily(known.familyId, 'reuse');
      throw httpError(401, 'REFRESH_TOKEN_REUSED', 'Your session was ended for safety. Please sign in again.');
    }
    throw httpError(401, 'INVALID_REFRESH_TOKEN', 'Please sign in again.');
  }

  return createSession({
    userId: current.userId,
    organizationId: organizationId || current.organizationId,
    familyId: current.familyId,
    userAgent,
    ip,
  });
}

async function revokeByToken(refreshToken, reason = 'logout') {
  if (!refreshToken) return;
  const session = await Session.findOne({ tokenHash: hashToken(refreshToken) });
  if (session) await revokeFamily(session.familyId, reason);
}

// Used when a member is removed: their sessions in that organization stop refreshing.
async function revokeMemberSessions(userId, organizationId) {
  await Session.updateMany({ userId, organizationId, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'removed' });
}

module.exports = { createSession, rotateSession, revokeByToken, revokeFamily, revokeMemberSessions };
