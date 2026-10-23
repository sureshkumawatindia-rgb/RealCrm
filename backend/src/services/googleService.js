const crypto = require('crypto');
const EmailMessage = require('../models/EmailMessage');
const GmailConnection = require('../models/GmailConnection');
const OAuthState = require('../models/OAuthState');
const OrganizationMember = require('../models/OrganizationMember');
const User = require('../models/User');
const google = require('../integrations/google');
const env = require('../config/env');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { encrypt, decrypt } = require('../utils/secretBox');
const { audit } = require('../utils/audit');
const { indiaDate } = require('../utils/dates');
const { notify } = require('./notificationService');
const queue = require('../jobs/queue');

// One member's Google account (Gmail since the start; Calendar and Drive in Phase 9, D90),
// Settings → My profile. Each feature adds only its own scope (Gmail read-only always;
// calendar.events and drive.file when asked), with include_granted_scopes. The state is single
// use (10 minutes) and tied to the member; tokens are kept only encrypted. accessFor gives a
// usable token (refreshed when it ends within 2 minutes); a refused refresh marks the connection
// needs_reconnect, sends a bell note and stops the sync — nothing else changes.
const STATE_MS = 10 * 60 * 1000;
const REFRESH_EARLY_MS = 2 * 60 * 1000;
const FEATURES = ['calendar', 'drive'];
const PROFILE_TAB = 'Settings.html?tab=profile';

// The Gmail sync of a connection: a job every 15 minutes (gmailSyncService does it).
const SYNC_JOB = 'google.gmail-sync';
const SYNC_EVERY_MS = 15 * 60 * 1000;
const syncKey = (connection) => `gmail-sync:${connection._id}`;
const schedule = (connection) => queue.every(SYNC_JOB, SYNC_EVERY_MS, { connectionId: String(connection._id) }, { uniqueKey: syncKey(connection), organizationId: connection.organizationId });
const unschedule = (connection) => queue.cancel(syncKey(connection));

const scopesFor = (features) => [google.SCOPES.gmail, ...FEATURES.filter((f) => features.includes(f)).map((f) => google.SCOPES[f])];
const callbackReq = (userId) => ({ user: { _id: userId }, ip: '', get: () => 'Google sign-in' });

function publicConnection(connection) {
  return {
    connected: true,
    emailAddress: connection.emailAddress,
    status: connection.status || 'active',
    features: { gmail: true, calendar: Boolean(connection.features?.calendar), drive: Boolean(connection.features?.drive) },
    shareEmails: connection.shareEmails !== false,
    lastSyncAt: connection.lastSyncAt || null,
    lastSyncCount: connection.lastSyncCount || 0,
    lastError: connection.lastError || '',
    calendarSyncFrom: connection.calendarSyncFrom || '',
    scopes: connection.scopes,
    connectedAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

// This member's connection in this company (a connection made in another company is not used here).
const connectionOf = (req) => GmailConnection.findOne({ userId: req.user._id, organizationId: req.tenant.organizationId });

async function status(req) {
  const connection = await connectionOf(req);
  if (connection) return { mode: google.mode(), ...publicConnection(connection) };
  const elsewhere = await GmailConnection.exists({ userId: req.user._id });
  return { mode: google.mode(), connected: false, elsewhere: Boolean(elsewhere) };
}

// POST /gmail/connect { features, returnUrl } → { authorizationUrl }
async function connect(req, { features = [], returnUrl }) {
  const provider = google.provider();
  if (!provider) throw httpError(409, 'GOOGLE_OFF', 'Google is not set up on this CRM yet. The platform owner adds a Google app first.');
  const wanted = FEATURES.filter((f) => features.includes(f));
  const state = crypto.randomBytes(32).toString('hex');
  await OAuthState.create({
    state, provider: 'gmail', userId: req.user._id, organizationId: req.tenant.organizationId, memberId: req.member._id, features: wanted, returnUrl, expiresAt: new Date(Date.now() + STATE_MS),
  });
  return { authorizationUrl: provider.authorizeUrl({ state, scopes: scopesFor(wanted), loginHint: req.user.email }) };
}

// GET /gmail/oauth/callback → { ok, params, returnUrl } for the redirect.
async function callback({ code, state, error: refused }) {
  if (refused) return { params: { gmail: 'error', reason: String(refused).slice(0, 60) } };
  if (!code || !state) return { params: { gmail: 'error', reason: 'missing_callback_parameters' } };
  const record = await OAuthState.findOneAndDelete({ state: String(state), provider: { $ne: 'microsoft' } }); // Microsoft has its own callback (D83)
  if (!record || record.expiresAt < new Date()) return { params: { gmail: 'error', reason: 'invalid_or_expired_state' } };
  const returnUrl = record.returnUrl;
  try {
    const provider = google.provider();
    if (!provider) return { params: { gmail: 'error', reason: 'google_off' }, returnUrl };
    const user = await User.findById(record.userId);
    if (!user) return { params: { gmail: 'error', reason: 'crm_user_not_found' }, returnUrl };
    const member = record.memberId
      ? await OrganizationMember.findOne({ _id: record.memberId, organizationId: record.organizationId, status: 'active' })
      : await OrganizationMember.findOne({ userId: user._id, organizationId: record.organizationId, status: 'active' });
    const tokens = await provider.exchangeCode({ code: String(code), loginHint: user.email });
    if (!tokens.accessToken || !tokens.refreshToken) return { params: { gmail: 'error', reason: 'refresh_token_missing' }, returnUrl };
    const features = record.features || [];
    const scopes = tokens.scopes?.length ? tokens.scopes : scopesFor(features);
    const granted = (feature) => scopes.includes(google.SCOPES[feature]);
    const profile = await provider.profile({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiryDate: tokens.expiryDate });
    const previous = await GmailConnection.findOne({ userId: user._id });
    const sameMailbox = previous && previous.emailAddress === String(profile.emailAddress).toLowerCase() && String(previous.organizationId) === String(record.organizationId);
    const connection = await GmailConnection.findOneAndUpdate(
      { userId: user._id },
      {
        $set: {
          organizationId: record.organizationId,
          memberId: member?._id,
          emailAddress: profile.emailAddress,
          encryptedAccessToken: encrypt(tokens.accessToken),
          encryptedRefreshToken: encrypt(tokens.refreshToken),
          tokenExpiry: new Date(tokens.expiryDate),
          scopes,
          features: { calendar: granted('calendar'), drive: granted('drive') },
          status: 'active',
          lastError: '',
          // A new mailbox (or company) starts its own sync; the same one carries on.
          ...(!sameMailbox && { historyId: '', lastSyncAt: null, lastSyncCount: 0 }),
          ...(!sameMailbox || !previous?.calendarSyncFrom ? { calendarSyncFrom: indiaDate(0) } : {}),
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );
    await audit(callbackReq(user._id), { organizationId: record.organizationId, action: 'google.connected', entityType: 'GmailConnection', entityId: connection._id, changes: { email: connection.emailAddress, features: connection.features } });
    await schedule(connection);
    return { params: { gmail: 'connected', email: connection.emailAddress }, returnUrl };
  } catch (error) {
    logger.error(`Google sign-in failed: ${error.code || error.message}`);
    return { params: { gmail: 'error', reason: String(error.code || 'gmail_callback_failed').toLowerCase() }, returnUrl };
  }
}

// PATCH /gmail/connection { shareEmails } — also changes the emails already synced.
async function update(req, { shareEmails }) {
  const connection = await connectionOf(req);
  if (!connection) throw httpError(404, 'GMAIL_NOT_CONNECTED', 'Google is not connected.');
  if (shareEmails !== undefined && shareEmails !== connection.shareEmails) {
    connection.shareEmails = shareEmails;
    await connection.save();
    await EmailMessage.updateMany({ connectionId: connection._id }, { $set: { shared: shareEmails } });
    await audit(req, { action: 'google.sharing', entityType: 'GmailConnection', entityId: connection._id, changes: { shareEmails } });
  }
  return publicConnection(connection);
}

// DELETE /gmail/connection — the tokens go; the emails already synced stay as CRM records.
async function disconnect(req) {
  const removed = await GmailConnection.findOneAndDelete({ userId: req.user._id, organizationId: req.tenant.organizationId });
  if (removed) {
    await unschedule(removed);
    await audit(req, { action: 'google.disconnected', entityType: 'GmailConnection', entityId: removed._id, changes: { email: removed.emailAddress } });
  }
  return { disconnected: Boolean(removed) };
}

async function markReconnect(connection, message) {
  const { modifiedCount } = await GmailConnection.updateOne({ _id: connection._id, status: { $ne: 'needs_reconnect' } }, { $set: { status: 'needs_reconnect', lastError: message } });
  connection.status = 'needs_reconnect';
  if (!modifiedCount) return;
  await unschedule(connection);
  if (!connection.memberId) return;
  try {
    await notify(connection.organizationId, [connection.memberId], {
      title: 'Connect Google again',
      body: 'Google stopped accepting the CRM\'s access, so your emails and meetings are not syncing. Open Settings → My profile and connect again.',
      link: PROFILE_TAB,
      source: 'google',
    });
  } catch (error) {
    logger.error(`Google reconnect note failed: ${error.message}`);
  }
}

// Credentials with a usable access token for this connection.
async function accessFor(connection) {
  if (connection.status === 'needs_reconnect') throw httpError(409, 'GOOGLE_RECONNECT', 'Google needs to be connected again (Settings → My profile).');
  const provider = google.provider();
  if (!provider) throw httpError(409, 'GOOGLE_OFF', 'Google is not set up on this CRM.');
  const creds = { accessToken: decrypt(connection.encryptedAccessToken), refreshToken: decrypt(connection.encryptedRefreshToken), expiryDate: connection.tokenExpiry?.getTime() || 0 };
  if (creds.expiryDate > Date.now() + REFRESH_EARLY_MS) return creds;
  try {
    const tokens = await provider.refresh({ refreshToken: creds.refreshToken });
    const set = { encryptedAccessToken: encrypt(tokens.accessToken), tokenExpiry: new Date(tokens.expiryDate), ...(tokens.refreshToken && { encryptedRefreshToken: encrypt(tokens.refreshToken) }) };
    await GmailConnection.updateOne({ _id: connection._id }, { $set: set });
    Object.assign(connection, set);
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || creds.refreshToken, expiryDate: tokens.expiryDate };
  } catch (error) {
    if (error.reconnect) await markReconnect(connection, error.message);
    throw error;
  }
}

// Runs a Google call; a refusal of the grant marks the connection, as a refused refresh does.
async function withGoogle(connection, fn) {
  const creds = await accessFor(connection);
  try {
    return await fn(google.provider(), creds);
  } catch (error) {
    if (error.reconnect) await markReconnect(connection, error.message);
    throw error;
  }
}

// GET /gmail/mock-consent — the stand-in's "Allow" (tests and development only).
function mockConsentRedirect(state) {
  if (google.mode() !== 'mock') throw httpError(404, 'NOT_FOUND', 'Not found');
  const url = new URL(env.googleRedirectUri);
  url.searchParams.set('code', `mock:${state}`);
  url.searchParams.set('state', String(state));
  return url.toString();
}

module.exports = { FEATURES, SYNC_JOB, schedule, unschedule, status, connect, callback, update, disconnect, markReconnect, accessFor, withGoogle, connectionOf, publicConnection, mockConsentRedirect };
