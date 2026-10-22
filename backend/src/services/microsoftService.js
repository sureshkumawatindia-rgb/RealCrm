const crypto = require('crypto');
const MicrosoftConnection = require('../models/MicrosoftConnection');
const OAuthState = require('../models/OAuthState');
const OrganizationMember = require('../models/OrganizationMember');
const microsoft = require('../integrations/microsoft');
const env = require('../config/env');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { encrypt, decrypt } = require('../utils/secretBox');
const { audit } = require('../utils/audit');
const { indiaDate } = require('../utils/dates');
const { notify } = require('./notificationService');

// Microsoft 365 for one member (Phase 4B, D83), like Gmail: Settings → My profile → Connect.
// Sign-in is the authorization code flow with PKCE and a single-use state (10 minutes) tied to
// the member; tokens are stored only encrypted; disconnect deletes them. accessTokenFor gives a
// usable token, refreshing it when it is about to end; a refused refresh asks the member to
// connect again (needs_reconnect, a bell note) and changes nothing else.
const STATE_MS = 10 * 60 * 1000;
const REFRESH_EARLY_MS = 2 * 60 * 1000;
const PROFILE_TAB = 'Settings.html?tab=profile';

const challengeOf = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');
const settingsUrl = (params) => {
  const url = new URL(`${env.frontendUrl.replace(/\/+$/, '')}/Settings.html`);
  url.searchParams.set('tab', 'profile');
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
};
// The audit log's "who" for the callback, which has no signed-in request.
const callbackReq = (userId) => ({ user: { _id: userId }, ip: '', get: () => 'Microsoft sign-in' });

function publicConnection(connection) {
  return {
    connected: true,
    email: connection.email,
    name: connection.name,
    status: connection.status,
    scopes: connection.scopes,
    calendarSyncFrom: connection.calendarSyncFrom,
    connectedAt: connection.createdAt,
    lastSyncAt: connection.lastSyncAt || null,
    lastError: connection.lastError || '',
  };
}

// GET /integrations/microsoft — this member's connection, and whether Microsoft is set up at all.
async function status(req) {
  const connection = await MicrosoftConnection.findOne({ organizationId: req.tenant.organizationId, memberId: req.member._id });
  return { mode: microsoft.mode(), connection: connection ? publicConnection(connection) : null };
}

// POST /integrations/microsoft/connect → { authorizationUrl }
async function connect(req) {
  const provider = microsoft.provider();
  if (!provider) throw httpError(409, 'MICROSOFT_OFF', 'Microsoft 365 is not set up on this CRM yet. The platform owner adds a Microsoft app first.');
  const state = crypto.randomBytes(32).toString('hex');
  const verifier = crypto.randomBytes(48).toString('base64url');
  await OAuthState.create({
    state,
    provider: 'microsoft',
    userId: req.user._id,
    organizationId: req.tenant.organizationId,
    memberId: req.member._id,
    codeVerifierEnc: encrypt(verifier),
    returnUrl: settingsUrl({}),
    expiresAt: new Date(Date.now() + STATE_MS),
  });
  return { authorizationUrl: provider.authorizeUrl({ state, codeChallenge: challengeOf(verifier), redirectUri: env.microsoft.redirectUri }) };
}

// GET /integrations/microsoft/callback — Microsoft's redirect. Returns where to send the browser.
async function callback({ code, state, error: refused }) {
  if (refused) return settingsUrl({ microsoft: 'error', reason: String(refused).slice(0, 60) });
  if (!code || !state) return settingsUrl({ microsoft: 'error', reason: 'missing_callback_parameters' });
  const record = await OAuthState.findOneAndDelete({ state: String(state), provider: 'microsoft' });
  if (!record || record.expiresAt < new Date()) return settingsUrl({ microsoft: 'error', reason: 'invalid_or_expired_state' });
  try {
    const member = await OrganizationMember.findOne({ _id: record.memberId, organizationId: record.organizationId, userId: record.userId, status: 'active' });
    if (!member) return settingsUrl({ microsoft: 'error', reason: 'member_not_found' });
    const provider = microsoft.provider();
    if (!provider) return settingsUrl({ microsoft: 'error', reason: 'microsoft_off' });
    const tokens = await provider.exchangeCode({ code: String(code), codeVerifier: decrypt(record.codeVerifierEnc), redirectUri: env.microsoft.redirectUri });
    if (!tokens.accessToken || !tokens.refreshToken) return settingsUrl({ microsoft: 'error', reason: 'refresh_token_missing' });
    const profile = await provider.me(tokens.accessToken);
    const connection = await MicrosoftConnection.findOneAndUpdate(
      { organizationId: record.organizationId, memberId: member._id },
      {
        $set: {
          userId: record.userId,
          microsoftUserId: profile.id || '',
          email: profile.email || '',
          name: profile.name || '',
          encryptedAccessToken: encrypt(tokens.accessToken),
          encryptedRefreshToken: encrypt(tokens.refreshToken),
          tokenExpiry: new Date(Date.now() + tokens.expiresIn * 1000),
          scopes: tokens.scope,
          status: 'active',
          lastError: '',
        },
        $setOnInsert: { calendarSyncFrom: indiaDate(0) },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    await audit(callbackReq(record.userId), { organizationId: record.organizationId, action: 'microsoft.connected', entityType: 'MicrosoftConnection', entityId: connection._id, changes: { email: connection.email } });
    return settingsUrl({ microsoft: 'connected' });
  } catch (error) {
    logger.error(`Microsoft sign-in failed: ${error.code || error.message}`);
    return settingsUrl({ microsoft: 'error', reason: String(error.code || 'microsoft_callback_failed').toLowerCase() });
  }
}

// DELETE /integrations/microsoft — the tokens are deleted; CRM data stays as it is.
async function disconnect(req) {
  const removed = await MicrosoftConnection.findOneAndDelete({ organizationId: req.tenant.organizationId, memberId: req.member._id });
  if (removed) await audit(req, { action: 'microsoft.disconnected', entityType: 'MicrosoftConnection', entityId: removed._id, changes: { email: removed.email } });
  return { disconnected: Boolean(removed) };
}

async function markReconnect(connection, message) {
  const { modifiedCount } = await MicrosoftConnection.updateOne({ _id: connection._id, status: 'active' }, { $set: { status: 'needs_reconnect', lastError: message } });
  if (!modifiedCount) return;
  try {
    await notify(connection.organizationId, [connection.memberId], {
      title: 'Connect Microsoft 365 again',
      body: 'Microsoft stopped accepting the CRM\'s sign-in, so your meetings are not reaching Outlook. Open Settings → My profile and connect again.',
      link: PROFILE_TAB,
      source: 'microsoft',
    });
  } catch (error) {
    logger.error(`Microsoft reconnect note failed: ${error.message}`);
  }
}

// A usable access token for this connection (refreshed when it ends within 2 minutes).
async function accessTokenFor(connection) {
  if (connection.status !== 'active') throw httpError(409, 'MICROSOFT_RECONNECT', 'Microsoft 365 needs to be connected again.');
  if (connection.tokenExpiry.getTime() > Date.now() + REFRESH_EARLY_MS) return decrypt(connection.encryptedAccessToken);
  const provider = microsoft.provider();
  if (!provider) throw httpError(409, 'MICROSOFT_OFF', 'Microsoft 365 is not set up on this CRM.');
  try {
    const tokens = await provider.refresh({ refreshToken: decrypt(connection.encryptedRefreshToken) });
    const set = { encryptedAccessToken: encrypt(tokens.accessToken), tokenExpiry: new Date(Date.now() + tokens.expiresIn * 1000), ...(tokens.refreshToken && { encryptedRefreshToken: encrypt(tokens.refreshToken) }) };
    await MicrosoftConnection.updateOne({ _id: connection._id }, { $set: set });
    Object.assign(connection, set);
    return tokens.accessToken;
  } catch (error) {
    if (error.reconnect) await markReconnect(connection, error.message);
    throw error;
  }
}

// GET /integrations/microsoft/mock-consent — the stand-in's "Accept" page (tests and development
// only): straight back to the callback, as Microsoft would after the person agrees.
function mockConsentRedirect(state) {
  if (microsoft.mode() !== 'mock') throw httpError(404, 'NOT_FOUND', 'Not found');
  const url = new URL(env.microsoft.redirectUri);
  url.searchParams.set('code', `mock:${state}`);
  url.searchParams.set('state', state);
  return url.toString();
}

module.exports = { status, connect, callback, disconnect, accessTokenFor, markReconnect, mockConsentRedirect, publicConnection };
