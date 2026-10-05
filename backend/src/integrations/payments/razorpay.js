const crypto = require('crypto');
const { call } = require('./http');

// Razorpay Payment Links (API v1), with the organization's key id and key secret (Basic auth).
// https://razorpay.com/docs/api/payments/payment-links/
// https://razorpay.com/docs/webhooks/payment-links/ — payment_link.paid / partially_paid / expired / cancelled
// https://razorpay.com/docs/webhooks/validate-test/ — X-Razorpay-Signature = hex HMAC-SHA256(raw body, webhook secret)
const NAME = 'Razorpay';
const BASE = 'https://api.razorpay.com/v1';
const STATUSES = { created: 'created', partially_paid: 'partially_paid', paid: 'paid', expired: 'expired', cancelled: 'cancelled' };

const auth = ({ keyId, keySecret }) => ({ Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` });
const fromUnix = (seconds) => (seconds ? new Date(Number(seconds) * 1000) : undefined);
const enc = encodeURIComponent;

// Test keys start rzp_test_, live keys rzp_live_.
const modeOf = (keyId) => (/^rzp_live_/.test(String(keyId)) ? 'live' : 'test');

// Our shape of a Razorpay payment link. Only captured payments count.
function normalize(link) {
  return {
    providerLinkId: String(link.id || ''),
    shortUrl: String(link.short_url || ''),
    status: STATUSES[link.status] || 'created',
    amountPaidPaise: Number(link.amount_paid) || 0,
    expiresAt: fromUnix(link.expire_by),
    payments: (Array.isArray(link.payments) ? link.payments : [])
      .filter((p) => p && p.payment_id && (!p.status || p.status === 'captured'))
      .map((p) => ({ providerPaymentId: String(p.payment_id), amountPaise: Number(p.amount) || 0, method: String(p.method || ''), paidAt: fromUnix(p.created_at) || new Date() })),
  };
}

module.exports = {
  name: NAME,
  modeOf,

  // A cheap authenticated call: right keys → the mode they belong to.
  async checkKeys(credentials) {
    await call(NAME, `${BASE}/payment_links?count=1`, { headers: auth(credentials) });
    return { mode: modeOf(credentials.keyId) };
  },

  // input: { referenceId, amountPaise, description, customer { name, phone, email }, expiresAt, acceptPartial, minPartialPaise, notes }
  async createLink(credentials, input) {
    const customer = Object.fromEntries(Object.entries({ name: input.customer?.name, contact: input.customer?.phone, email: input.customer?.email }).filter(([, v]) => v));
    const data = await call(NAME, `${BASE}/payment_links`, {
      method: 'POST',
      headers: auth(credentials),
      body: {
        amount: input.amountPaise,
        currency: 'INR',
        accept_partial: Boolean(input.acceptPartial),
        ...(input.acceptPartial && { first_min_partial_amount: input.minPartialPaise || 100 }),
        ...(input.expiresAt && { expire_by: Math.floor(input.expiresAt.getTime() / 1000) }),
        reference_id: input.referenceId,
        description: String(input.description || '').slice(0, 2048),
        ...(Object.keys(customer).length && { customer }),
        // The CRM sends the link on WhatsApp itself.
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: input.notes || {},
      },
    });
    return normalize(data);
  },

  async fetchLink(credentials, providerLinkId) {
    return normalize(await call(NAME, `${BASE}/payment_links/${enc(providerLinkId)}`, { headers: auth(credentials) }));
  },

  async cancelLink(credentials, providerLinkId) {
    return normalize(await call(NAME, `${BASE}/payment_links/${enc(providerLinkId)}/cancel`, { method: 'POST', headers: auth(credentials) }));
  },

  // headers: lower-case names. secrets: { webhookSecret }.
  verifyWebhook({ rawBody, headers, secrets }) {
    const signature = String(headers['x-razorpay-signature'] || '');
    if (!secrets.webhookSecret || !/^[a-f0-9]{64}$/i.test(signature) || !Buffer.isBuffer(rawBody)) return false;
    const expected = crypto.createHmac('sha256', secrets.webhookSecret).update(rawBody).digest();
    return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  },

  // → { eventId, providerLinkId, status, amountPaidPaise, payment? } or null (not a payment link event).
  parseWebhook(payload, headers = {}) {
    if (!/^payment_link\./.test(String(payload?.event || ''))) return null;
    const link = payload.payload?.payment_link?.entity || {};
    const payment = payload.payload?.payment?.entity;
    if (!link.id) return null;
    const captured = payment?.id && (!payment.status || payment.status === 'captured');
    return {
      eventId: String(headers['x-razorpay-event-id'] || `${payload.event}:${link.id}:${payment?.id || ''}`),
      providerLinkId: String(link.id),
      status: STATUSES[link.status] || 'created',
      amountPaidPaise: Number(link.amount_paid) || 0,
      payment: captured ? { providerPaymentId: String(payment.id), amountPaise: Number(payment.amount) || 0, method: String(payment.method || ''), paidAt: fromUnix(payment.created_at) || new Date() } : null,
    };
  },
};
