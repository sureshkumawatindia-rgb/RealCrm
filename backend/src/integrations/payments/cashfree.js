const crypto = require('crypto');
const { call } = require('./http');

// Cashfree Payment Links (PG API, x-api-version below), with the organization's app id and secret.
// https://www.cashfree.com/docs/api-reference/payments/latest/payment-links/create
// https://www.cashfree.com/docs/api-reference/payments/latest/payment-links/webhooks — PAYMENT_LINK_EVENT
// https://www.cashfree.com/docs/payments/online/webhooks/signature-verification —
//   x-webhook-signature = base64 HMAC-SHA256(x-webhook-timestamp + raw body, secret key)
// Amounts are rupees with paise as decimals; the link_id is ours (our referenceId).
const NAME = 'Cashfree';
const API_VERSION = '2026-01-01';
const BASES = { test: 'https://sandbox.cashfree.com/pg', live: 'https://api.cashfree.com/pg' };
const STATUSES = { ACTIVE: 'created', PARTIALLY_PAID: 'partially_paid', PAID: 'paid', EXPIRED: 'expired', CANCELLED: 'cancelled' };

const headers = ({ keyId, keySecret }) => ({ 'x-client-id': keyId, 'x-client-secret': keySecret, 'x-api-version': API_VERSION });
const base = (credentials) => BASES[credentials.mode === 'live' ? 'live' : 'test'];
const toPaise = (rupees) => Math.round((Number(rupees) || 0) * 100);
const enc = encodeURIComponent;

// "2026-10-12T18:30:00+05:30" (India time, as in Cashfree's examples).
function istIso(date) {
  const india = new Date(date.getTime() + 330 * 60 * 1000);
  return `${india.toISOString().slice(0, 19)}+05:30`;
}

// Indian numbers as 10 digits, others with their country code (no "+").
const phoneOf = (e164) => (String(e164 || '').startsWith('+91') ? e164.slice(3) : String(e164 || '').replace(/\D/g, ''));

function normalize(link, payments = []) {
  return {
    providerLinkId: String(link.link_id || ''),
    shortUrl: String(link.link_url || ''),
    status: STATUSES[String(link.link_status || '').toUpperCase()] || 'created',
    amountPaidPaise: toPaise(link.link_amount_paid),
    expiresAt: link.link_expiry_time ? new Date(link.link_expiry_time) : undefined,
    payments,
  };
}

module.exports = {
  name: NAME,

  // An authenticated call for a link that does not exist: "not found" means the keys work.
  async checkKeys(credentials) {
    try {
      await call(NAME, `${base(credentials)}/links/ycrm-key-check`, { headers: headers(credentials) });
    } catch (error) {
      if (error.gatewayStatus !== 404) throw error;
    }
    return { mode: credentials.mode === 'live' ? 'live' : 'test' };
  },

  async createLink(credentials, input) {
    const customer = Object.fromEntries(Object.entries({
      customer_phone: phoneOf(input.customer?.phone), customer_name: input.customer?.name, customer_email: input.customer?.email,
    }).filter(([, v]) => v));
    const data = await call(NAME, `${base(credentials)}/links`, {
      method: 'POST',
      headers: headers(credentials),
      body: {
        link_id: input.referenceId,
        link_amount: input.amountPaise / 100,
        link_currency: 'INR',
        link_purpose: String(input.description || 'Payment').slice(0, 500),
        customer_details: customer,
        link_partial_payments: Boolean(input.acceptPartial),
        ...(input.acceptPartial && { link_minimum_partial_amount: (input.minPartialPaise || 100) / 100 }),
        ...(input.expiresAt && { link_expiry_time: istIso(input.expiresAt) }),
        // The CRM sends the link on WhatsApp itself.
        link_notify: { send_sms: false, send_email: false },
        link_auto_reminders: false,
        link_notes: Object.fromEntries(Object.entries(input.notes || {}).slice(0, 5)),
      },
    });
    return normalize(data);
  },

  // The link, and its paid orders (each successful payment is an "order" of the link).
  async fetchLink(credentials, providerLinkId) {
    const link = await call(NAME, `${base(credentials)}/links/${enc(providerLinkId)}`, { headers: headers(credentials) });
    const orders = await call(NAME, `${base(credentials)}/links/${enc(providerLinkId)}/orders?status=PAID`, { headers: headers(credentials) });
    const list = Array.isArray(orders) ? orders : Array.isArray(orders?.orders) ? orders.orders : [];
    const payments = list
      .filter((o) => o?.order_id && String(o.order_status || '').toUpperCase() === 'PAID')
      .map((o) => ({ providerPaymentId: String(o.order_id), amountPaise: toPaise(o.order_amount), method: '', paidAt: o.created_at ? new Date(o.created_at) : new Date() }));
    return normalize(link, payments);
  },

  async cancelLink(credentials, providerLinkId) {
    return normalize(await call(NAME, `${base(credentials)}/links/${enc(providerLinkId)}/cancel`, { method: 'POST', headers: headers(credentials) }));
  },

  // secrets: { keySecret } — Cashfree signs webhooks with the API secret key.
  verifyWebhook({ rawBody, headers: received, secrets }) {
    const signature = String(received['x-webhook-signature'] || '');
    const timestamp = String(received['x-webhook-timestamp'] || '');
    if (!secrets.keySecret || !signature || !timestamp || !Buffer.isBuffer(rawBody)) return false;
    const expected = crypto.createHmac('sha256', secrets.keySecret).update(Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody])).digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  parseWebhook(payload) {
    if (payload?.type !== 'PAYMENT_LINK_EVENT' || !payload.data?.link_id) return null;
    const { data } = payload;
    const order = data.order || {};
    const succeeded = order.order_id && String(order.transaction_status || '').toUpperCase() === 'SUCCESS';
    return {
      eventId: `${data.link_id}:${order.order_id || ''}:${order.transaction_status || data.link_status || ''}`,
      providerLinkId: String(data.link_id),
      status: STATUSES[String(data.link_status || '').toUpperCase()] || 'created',
      amountPaidPaise: toPaise(data.link_amount_paid),
      payment: succeeded ? { providerPaymentId: String(order.order_id), amountPaise: toPaise(order.order_amount), method: '', paidAt: payload.event_time ? new Date(payload.event_time) : new Date() } : null,
    };
  },

  istIso,
};
