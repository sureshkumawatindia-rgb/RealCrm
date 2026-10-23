const express = require('express');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const env = require('../config/env');
const googleService = require('../services/googleService');
const gmailSync = require('../services/gmailSyncService');
const schemas = require('../validators/google');

// Google for one member (Gmail since the start; Calendar and Drive since Phase 9, D90). The
// sign-in and the sync live in googleService and gmailSyncService, behind the Google adapter
// (live, or the stand-in in tests and development).
const router = express.Router();

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
  url.searchParams.set('tab', 'profile');
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

router.get('/connection', authenticate, async (req, res) => {
  res.json({ success: true, data: await googleService.status(req) });
});
router.post('/connect', authenticate, validate({ body: schemas.connect }), async (req, res) => {
  res.json({ success: true, data: await googleService.connect(req, { features: req.body.features, returnUrl: getSafeReturnUrl(req.body.returnUrl) }) });
});
router.get('/oauth/callback', async (req, res) => {
  const { params, returnUrl } = await googleService.callback(req.query);
  res.redirect(frontendRedirect(params, returnUrl));
});
// The stand-in's consent page (tests and development only).
router.get('/mock-consent', (req, res) => {
  res.redirect(googleService.mockConsentRedirect(req.query.state));
});
router.patch('/connection', authenticate, validate({ body: schemas.connectionPatch }), async (req, res) => {
  res.json({ success: true, data: await googleService.update(req, req.body) });
});
router.delete('/connection', authenticate, async (req, res) => {
  res.json({ success: true, data: await googleService.disconnect(req) });
});
router.post('/sync', authenticate, async (req, res) => {
  res.json({ success: true, data: await gmailSync.syncNow(req) });
});
router.get('/threads/:threadId', authenticate, validate({ params: schemas.threadParams }), async (req, res) => {
  res.json({ success: true, data: await gmailSync.thread(req, req.valid.params.threadId) });
});

async function connectionOrFail(req, res) {
  const connection = await googleService.connectionOf(req);
  if (!connection) res.status(404).json({ success: false, message: 'Gmail is not connected', code: 'GMAIL_NOT_CONNECTED' });
  return connection;
}

router.get('/profile', authenticate, async (req, res) => {
  const connection = await connectionOrFail(req, res);
  if (!connection) return;
  const profile = await googleService.withGoogle(connection, (provider, creds) => provider.profile(creds));
  res.json({ success: true, data: { emailAddress: profile.emailAddress, messagesTotal: profile.messagesTotal } });
});

// Live Gmail search (read-only), as before Phase 9.
router.get('/messages', authenticate, validate({ query: schemas.messages }), async (req, res) => {
  const connection = await connectionOrFail(req, res);
  if (!connection) return;
  const { limit, q } = req.valid.query;
  const messages = await googleService.withGoogle(connection, async (provider, creds) => {
    const list = await provider.listMessages(creds, { q, maxResults: limit });
    return Promise.all(list.messages.map(async ({ id }) => {
      const m = await provider.getMessage(creds, id);
      return { id, threadId: m.threadId, snippet: m.snippet, from: m.headers.from, to: m.headers.to, subject: m.headers.subject, date: m.headers.date };
    }));
  });
  res.json({ success: true, data: { messages } });
});

module.exports = router;
