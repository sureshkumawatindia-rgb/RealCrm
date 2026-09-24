const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

const ISSUER = 'yellow-crm';
const AUDIENCE = 'yellow-crm-api';

// Short-lived access token. sub = user id, org = active organization, sid = session id.
function signAccessToken({ userId, organizationId, sessionId }) {
  return jwt.sign(
    { org: String(organizationId), sid: String(sessionId) },
    env.jwtSecret,
    { subject: String(userId), expiresIn: env.accessTokenTtl, issuer: ISSUER, audience: AUDIENCE, algorithm: 'HS256' },
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtSecret, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
}

// Opaque random tokens (refresh tokens, invite tokens). Only their hash is stored.
function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { signAccessToken, verifyAccessToken, randomToken, hashToken };
