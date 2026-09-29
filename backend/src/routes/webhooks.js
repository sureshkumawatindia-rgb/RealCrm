const crypto = require('crypto');
const express = require('express');
const accountService = require('../services/whatsappAccountService');
const inbound = require('../services/whatsappInboundService');
const indiamart = require('../services/indiamartService');
const { webhookLimiter } = require('../middleware/rateLimit');

// Public endpoints that other services call (no sign-in). Mounted before the JSON parser and
// the API rate limit: req.body is the raw bytes, so signatures are checked on exactly what
// was sent.
const router = express.Router();
router.use(webhookLimiter);

const sameText = (a, b) => {
  const hash = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();
  return typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(hash(a), hash(b));
};

// Meta's handshake when the callback URL is saved in the app:
// ?hub.mode=subscribe&hub.verify_token=<ours>&hub.challenge=<theirs> → 200 with the challenge.
router.get('/whatsapp/:webhookKey', async (req, res) => {
  const account = await accountService.findByWebhookKey(req.params.webhookKey);
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (!account || mode !== 'subscribe' || !sameText(token, accountService.verifyTokenOf(account)) || typeof challenge !== 'string') {
    return res.sendStatus(403);
  }
  res.type('text/plain').send(challenge.slice(0, 200));
});

// Messages and delivery statuses. Anything but 200 makes Meta retry (for up to 7 days).
router.post('/whatsapp/:webhookKey', async (req, res) => {
  const account = await accountService.findByWebhookKey(req.params.webhookKey);
  if (!account) return res.sendStatus(404);
  if (!inbound.signatureOk(account, req.body, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }
  const ids = await inbound.ingest(account, payload);
  res.sendStatus(200);
  inbound.processLater(ids);
});

// IndiaMART push: one lead per POST, JSON { CODE, STATUS, RESPONSE: { UNIQUE_QUERY_ID, … } }. There
// is no signature; the random key in the URL is the secret. IndiaMART retries until it gets 200.
router.post('/leads/indiamart/:webhookKey', async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}');
  } catch {
    return res.sendStatus(400);
  }
  const { status } = await indiamart.handlePush(req.params.webhookKey, payload);
  res.sendStatus(status);
});

module.exports = router;
