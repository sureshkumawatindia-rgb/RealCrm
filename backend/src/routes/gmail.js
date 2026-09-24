const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const User = require('../models/User');
const OAuthState = require('../models/OAuthState');
const GmailConnection = require('../models/GmailConnection');
const { authenticate } = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/secretBox');
const env = require('../config/env');
const logger = require('../config/logger');

const router = express.Router();
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

function oauthClient() {
  if (!env.googleClientSecret) {
    const error = new Error('GOOGLE_CLIENT_SECRET is not configured');
    error.statusCode = 500;
    error.code = 'GOOGLE_CLIENT_SECRET_MISSING';
    throw error;
  }
  return new google.auth.OAuth2(env.googleClientId, env.googleClientSecret, env.googleRedirectUri);
}

function getSafeReturnUrl(candidate) {
  try {
    const url = new URL(candidate || env.frontendUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported return URL protocol');
    const configuredOrigin = new URL(env.frontendUrl).origin;
    const localOrigin = /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
    if (url.origin !== configuredOrigin && !localOrigin) throw new Error('Untrusted return URL');
    const directory = candidate
      ? (url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/')
      : (url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`);
    return new URL(`${directory}Settings.html`, url.origin).toString();
  } catch {
    const fallback = new URL(env.frontendUrl);
    const directory = fallback.pathname.endsWith('/') ? fallback.pathname : `${fallback.pathname}/`;
    return new URL(`${directory}Settings.html`, fallback.origin).toString();
  }
}

function frontendRedirect(params, returnUrl) {
  const url = new URL(getSafeReturnUrl(returnUrl));
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

function publicConnection(connection) {
  return {
    connected: true,
    emailAddress: connection.emailAddress,
    scopes: connection.scopes,
    connectedAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

async function getGmailClient(connection) {
  const client = oauthClient();
  client.setCredentials({
    access_token: decrypt(connection.encryptedAccessToken),
    refresh_token: decrypt(connection.encryptedRefreshToken),
    expiry_date: connection.tokenExpiry?.getTime(),
  });
  client.on('tokens', async (tokens) => {
    if (tokens.access_token) connection.encryptedAccessToken = encrypt(tokens.access_token);
    if (tokens.expiry_date) connection.tokenExpiry = new Date(tokens.expiry_date);
    await connection.save();
  });
  return google.gmail({ version: 'v1', auth: client });
}

router.get('/connection', authenticate, async (req, res, next) => {
  try {
    const connection = await GmailConnection.findOne({ userId: req.user._id });
    res.json({ success: true, data: connection ? publicConnection(connection) : { connected: false } });
  } catch (error) {
    next(error);
  }
});

router.post('/connect', authenticate, async (req, res, next) => {
  try {
    const state = crypto.randomBytes(32).toString('hex');
    await OAuthState.create({
      state,
      userId: req.user._id,
      returnUrl: getSafeReturnUrl(req.body?.returnUrl),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const client = oauthClient();
    const authorizationUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: GMAIL_SCOPES,
      state,
    });
    res.json({ success: true, data: { authorizationUrl } });
  } catch (error) {
    next(error);
  }
});

router.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return res.redirect(frontendRedirect({ gmail: 'error', reason: oauthError }));
    if (!code || !state) return res.redirect(frontendRedirect({ gmail: 'error', reason: 'missing_callback_parameters' }));

    const stateRecord = await OAuthState.findOneAndDelete({ state });
    if (!stateRecord || stateRecord.expiresAt < new Date()) {
      return res.redirect(frontendRedirect({ gmail: 'error', reason: 'invalid_or_expired_state' }));
    }

    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token || !tokens.refresh_token) {
      return res.redirect(frontendRedirect({ gmail: 'error', reason: 'refresh_token_missing' }, stateRecord.returnUrl));
    }
    client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const user = await User.findById(stateRecord.userId);
    if (!user) return res.redirect(frontendRedirect({ gmail: 'error', reason: 'crm_user_not_found' }, stateRecord.returnUrl));

    const connection = await GmailConnection.findOneAndUpdate(
      { userId: user._id },
      {
        userId: user._id,
        organizationId: user.organizationId,
        emailAddress: profile.data.emailAddress,
        encryptedAccessToken: encrypt(tokens.access_token),
        encryptedRefreshToken: encrypt(tokens.refresh_token),
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
        historyId: profile.data.historyId || '',
        scopes: GMAIL_SCOPES,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return res.redirect(frontendRedirect({ gmail: 'connected', email: connection.emailAddress }, stateRecord.returnUrl));
  } catch (error) {
    const reason = error.response?.data?.error?.status || error.code || 'gmail_callback_failed';
    logger.error(`Gmail OAuth callback failed at downstream stage: ${reason}`);
    return res.redirect(frontendRedirect({ gmail: 'error', reason: String(reason) }));
  }
});

router.get('/profile', authenticate, async (req, res, next) => {
  try {
    const connection = await GmailConnection.findOne({ userId: req.user._id });
    if (!connection) return res.status(404).json({ success: false, message: 'Gmail is not connected', code: 'GMAIL_NOT_CONNECTED' });
    const gmail = await getGmailClient(connection);
    const profile = await gmail.users.getProfile({ userId: 'me' });
    connection.emailAddress = profile.data.emailAddress;
    connection.historyId = profile.data.historyId || connection.historyId;
    await connection.save();
    res.json({ success: true, data: { emailAddress: connection.emailAddress, messagesTotal: profile.data.messagesTotal, threadsTotal: profile.data.threadsTotal } });
  } catch (error) {
    next(error);
  }
});

router.get('/messages', authenticate, async (req, res, next) => {
  try {
    const connection = await GmailConnection.findOne({ userId: req.user._id });
    if (!connection) return res.status(404).json({ success: false, message: 'Gmail is not connected', code: 'GMAIL_NOT_CONNECTED' });
    const gmail = await getGmailClient(connection);
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const list = await gmail.users.messages.list({ userId: 'me', maxResults: limit, q: req.query.q || '' });
    const messages = await Promise.all((list.data.messages || []).map(async ({ id }) => {
      const result = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] });
      const headers = Object.fromEntries((result.data.payload?.headers || []).map(({ name, value }) => [name.toLowerCase(), value]));
      return { id, threadId: result.data.threadId, snippet: result.data.snippet || '', ...headers };
    }));
    res.json({ success: true, data: { messages } });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
