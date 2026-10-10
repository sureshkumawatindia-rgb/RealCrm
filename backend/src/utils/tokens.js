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

// Between the Google step and the WhatsApp code step of signing in: who passed Google (and the
// invite's organization), for 10 minutes. Its own audience, so it never works as an access token.
const LOGIN_AUDIENCE = 'yellow-crm-login';
// ws: the company typed on the login page (D66), checked again when the code is right.
function signLoginChallenge({ userId, invitedOrganizationId, inviteError, workspaceId = null }) {
  return jwt.sign(
    {
      inv: invitedOrganizationId ? String(invitedOrganizationId) : null,
      err: inviteError ? { code: inviteError.code, message: inviteError.message } : null,
      ...(workspaceId && { ws: String(workspaceId) }),
    },
    env.jwtSecret,
    { subject: String(userId), expiresIn: '10m', issuer: ISSUER, audience: LOGIN_AUDIENCE, algorithm: 'HS256' },
  );
}
function verifyLoginChallenge(token) {
  return jwt.verify(token, env.jwtSecret, { issuer: ISSUER, audience: LOGIN_AUDIENCE, algorithms: ['HS256'] });
}

// Opaque random tokens (refresh tokens, invite tokens). Only their hash is stored.
function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { signAccessToken, verifyAccessToken, signLoginChallenge, verifyLoginChallenge, randomToken, hashToken };
