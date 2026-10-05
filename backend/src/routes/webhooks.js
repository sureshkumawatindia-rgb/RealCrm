const crypto = require('crypto');
const express = require('express');
const accountService = require('../services/whatsappAccountService');
const inbound = require('../services/whatsappInboundService');
const indiamart = require('../services/indiamartService');
const leadWebhooks = require('../services/leadWebhookService');
const paymentLinks = require('../services/paymentLinkService');
const queue = require('../jobs/queue');
const env = require('../config/env');
const { formatRupees } = require('../utils/money');
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

// The body as JSON or form fields, whatever the sender used (JustDial / TradeIndia vary).
function parseBody(req) {
  const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

// Facebook Lead Ads: Meta's handshake, then signed "leadgen" notifications.
router.get('/leads/facebook/:webhookKey', async (req, res) => {
  const { status, body } = await leadWebhooks.facebookVerify(req.params.webhookKey, req.query);
  if (status !== 200) return res.sendStatus(status);
  return res.type('text/plain').send(body);
});
router.post('/leads/facebook/:webhookKey', async (req, res) => {
  const { status } = await leadWebhooks.facebookReceive(req.params.webhookKey, req.body, req.get('x-hub-signature-256'), queue);
  res.sendStatus(status);
});

// Google Ads lead forms: JSON with the key typed into the form; answered with {}.
router.post('/leads/googleads/:webhookKey', async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');
  } catch {
    return res.status(400).json({ error: 'Expected JSON' });
  }
  const { status, body } = await leadWebhooks.googleAdsReceive(req.params.webhookKey, payload);
  return res.status(status).json(body);
});

// Payment gateways (Phase 8): Razorpay and Cashfree, one address per connection (D39). The
// signature is checked on the raw body; the payment is handled by a job after the 200.
router.post('/payments/:provider/:webhookKey', async (req, res) => {
  const { status } = await paymentLinks.receiveWebhook(req.params.provider, req.params.webhookKey, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.headers);
  res.sendStatus(status);
});

// The test gateway's payment page (development only): what a customer sees after tapping a
// test link, with a button that pays it the way a gateway would report it.
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function testPayPage(link, note = '') {
  const left = link ? link.amountPaise - link.amountPaidPaise : 0;
  const open = link && ['created', 'partially_paid'].includes(link.status);
  const body = !link ? '<p>This payment link does not exist.</p>'
    : `<p class="muted">Test payment — no money moves</p>
      <h1>${esc(formatRupees(left > 0 ? left : link.amountPaise))}</h1>
      <p>${esc(link.description)}${link.customerName ? `<br>for ${esc(link.customerName)}` : ''}</p>
      ${note ? `<p class="note">${esc(note)}</p>` : ''}
      ${open ? `<form method="post">
        ${link.acceptPartial ? `<label>Amount (₹) <input name="amount" inputmode="decimal" value="${esc((left / 100).toFixed(2))}"></label>` : ''}
        <button type="submit">Pay ${link.acceptPartial ? '' : esc(formatRupees(left))} (test)</button>
      </form>` : `<p class="note">This link is ${esc(link.status.replace('_', ' '))}.</p>`}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Test payment</title>
    <style>body{font-family:system-ui,sans-serif;background:#f5f6f8;margin:0;display:grid;place-items:center;min-height:100vh}
    main{background:#fff;border-radius:12px;padding:28px;max-width:360px;width:calc(100% - 32px);box-shadow:0 4px 20px rgba(0,0,0,.08);text-align:center}
    h1{margin:8px 0;font-size:32px}.muted{color:#777;font-size:13px;margin:0}.note{background:#fff7d6;border-radius:8px;padding:8px}
    input{display:block;width:100%;box-sizing:border-box;margin:6px 0 12px;padding:10px;font-size:16px;border:1px solid #ccc;border-radius:8px}
    button{width:100%;padding:12px;font-size:16px;border:0;border-radius:8px;background:#1a7f37;color:#fff;cursor:pointer}</style></head>
    <body><main>${body}</main></body></html>`;
}
router.get('/payments-test/:providerLinkId', async (req, res) => {
  if (env.isProduction) return res.sendStatus(404);
  const link = await paymentLinks.testLink(req.params.providerLinkId);
  return res.status(link ? 200 : 404).type('html').send(testPayPage(link));
});
router.post('/payments-test/:providerLinkId', async (req, res) => {
  if (env.isProduction) return res.sendStatus(404);
  const form = new URLSearchParams(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');
  const rupees = Number(String(form.get('amount') || '').replace(/[₹,\s]/g, ''));
  let note = '';
  try {
    const { amountPaise } = await paymentLinks.payTestLink(req.params.providerLinkId, Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : undefined);
    note = `Paid ${formatRupees(amountPaise)}. The CRM records it in a moment.`;
  } catch (error) {
    note = error.message;
  }
  const link = await paymentLinks.testLink(req.params.providerLinkId);
  return res.status(link ? 200 : 404).type('html').send(testPayPage(link, note));
});

// JustDial / TradeIndia: any format, as a GET with query parameters or a POST.
router.all(['/leads/justdial/:webhookKey', '/leads/tradeindia/:webhookKey'], async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return res.sendStatus(405);
  const type = req.path.split('/')[2];
  const payload = req.method === 'GET' ? { ...req.query } : parseBody(req);
  const { status } = await leadWebhooks.genericReceive(type, req.params.webhookKey, payload);
  return res.status(status).type('text/plain').send(status === 200 ? 'OK' : '');
});

module.exports = router;
