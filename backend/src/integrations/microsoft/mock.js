const crypto = require('crypto');
const env = require('../../config/env');
const { SCOPES, failure } = require('./graph');

// A stand-in for Microsoft (Phase 4B, D83) in tests and development (DEV_TOOLS=on), never in
// production. It checks PKCE like Microsoft does, keeps events in memory, makes Teams links, and
// can be told to fail (failNext) or to revoke the sign-in (revoke), so every path can be tested.
const challenges = new Map(); // state → PKCE challenge
const events = new Map(); // id → event
const transactions = new Map(); // transactionId → id (Graph's own guard against double creates)
const revoked = new Set();
let user = { id: 'mock-user', name: 'Mock User', email: 'mock.user@contoso.example' };
let failures = [];
let counter = 0;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('base64url');
const takeFailure = () => {
  const next = failures.shift();
  if (next) throw failure(next.message || `Microsoft answered ${next.status || 503}.`, next);
};

function authorizeUrl({ state, codeChallenge }) {
  challenges.set(state, codeChallenge);
  return `${env.publicUrl}/api/v1/integrations/microsoft/mock-consent?state=${encodeURIComponent(state)}`;
}

function tokens() {
  const id = crypto.randomBytes(6).toString('hex');
  return { accessToken: `mock-access-${id}`, refreshToken: `mock-refresh-${id}`, expiresIn: 3600, scope: [...SCOPES] };
}

async function exchangeCode({ code, codeVerifier }) {
  const state = String(code || '').replace(/^mock:/, '');
  const challenge = challenges.get(state);
  challenges.delete(state);
  if (!challenge || !codeVerifier || sha256(codeVerifier) !== challenge) throw failure('Microsoft refused the sign-in (invalid_grant).', { status: 400 });
  return tokens();
}

async function refresh({ refreshToken }) {
  takeFailure();
  if (revoked.has(refreshToken)) throw failure('Microsoft 365 needs to be connected again.', { status: 409, reconnect: true });
  return { ...tokens(), refreshToken };
}

async function me() {
  return { ...user };
}

async function createEvent(accessToken, event) {
  takeFailure();
  if (event.transactionId && transactions.has(event.transactionId)) {
    const existing = events.get(transactions.get(event.transactionId));
    if (existing) return { id: existing.id, joinUrl: existing.joinUrl };
  }
  counter += 1;
  const id = `mock-event-${counter}`;
  const saved = { ...event, id, owner: accessToken, joinUrl: event.isOnlineMeeting ? `https://teams.microsoft.com/l/meetup-join/mock-${counter}` : '' };
  events.set(id, saved);
  if (event.transactionId) transactions.set(event.transactionId, id);
  return { id, joinUrl: saved.joinUrl };
}

async function updateEvent(accessToken, id, event) {
  takeFailure();
  const existing = events.get(id);
  if (!existing) throw failure('Microsoft answered 404.', { status: 404 });
  const joinUrl = existing.joinUrl || (event.isOnlineMeeting ? `https://teams.microsoft.com/l/meetup-join/mock-${id.split('-').pop()}` : '');
  events.set(id, { ...existing, ...event, joinUrl });
  return { id, joinUrl };
}

async function deleteEvent(accessToken, id) {
  takeFailure();
  events.delete(id);
}

module.exports = {
  name: 'mock', SCOPES, authorizeUrl, exchangeCode, refresh, me, createEvent, updateEvent, deleteEvent,
  // For tests and the preview.
  setUser: (next) => { user = { ...user, ...next }; },
  failNext: (...list) => { failures.push(...list); },
  revoke: (refreshToken) => revoked.add(refreshToken),
  events: () => [...events.values()],
  reset: () => {
    challenges.clear(); events.clear(); transactions.clear(); revoked.clear(); failures = []; counter = 0;
    user = { id: 'mock-user', name: 'Mock User', email: 'mock.user@contoso.example' };
  },
};
