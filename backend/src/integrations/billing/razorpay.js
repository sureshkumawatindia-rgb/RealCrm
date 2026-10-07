const { call } = require('../payments/http');
const payments = require('../payments/razorpay');

// Razorpay Subscriptions (API v1) on the platform's own keys, for the SaaS plans (Phase 10B).
// https://razorpay.com/docs/api/payments/subscriptions/ — plans, subscriptions (create, fetch,
//   update with schedule_change_at, cancel with cancel_at_cycle_end), GET /invoices?subscription_id=
// https://razorpay.com/docs/webhooks/subscriptions/ — subscription.authenticated / activated /
//   charged / pending / halted / cancelled / completed / updated / paused / resumed
// https://razorpay.com/docs/webhooks/validate-test/ — X-Razorpay-Signature = hex HMAC-SHA256(raw
//   body, webhook secret); X-Razorpay-Event-Id tells retries apart
const NAME = 'Razorpay';
const BASE = 'https://api.razorpay.com/v1';
// Monthly plans, for up to 10 years (Razorpay needs a total count).
const TOTAL_COUNT = 120;

const auth = ({ keyId, keySecret }) => ({ Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` });
const fromUnix = (seconds) => (seconds ? new Date(Number(seconds) * 1000) : null);
const unix = (date) => Math.floor(new Date(date).getTime() / 1000);
const enc = encodeURIComponent;

// Our shape of a Razorpay subscription (its own status words: created, authenticated, active,
// pending, halted, cancelled, completed, expired, paused).
function normalize(sub) {
  return {
    id: String(sub.id || ''),
    planId: String(sub.plan_id || ''),
    status: String(sub.status || 'created'),
    customerId: String(sub.customer_id || ''),
    currentStart: fromUnix(sub.current_start),
    currentEnd: fromUnix(sub.current_end),
    chargeAt: fromUnix(sub.charge_at),
    startAt: fromUnix(sub.start_at),
    endedAt: fromUnix(sub.ended_at),
    paidCount: Number(sub.paid_count) || 0,
    shortUrl: String(sub.short_url || ''),
    hasScheduledChanges: Boolean(sub.has_scheduled_changes),
    notes: sub.notes && typeof sub.notes === 'object' && !Array.isArray(sub.notes) ? sub.notes : {},
  };
}

const captured = (payment) => payment?.id && (!payment.status || ['captured', 'authorized'].includes(payment.status));
const normalizePayment = (payment) => ({ id: String(payment.id), amountPaise: Number(payment.amount) || 0, method: String(payment.method || ''), paidAt: fromUnix(payment.created_at) || new Date(), invoiceId: String(payment.invoice_id || '') });

module.exports = {
  name: NAME,

  // A plan per CRM plan and price (item.amount is what is charged each month, GST included).
  async createPlan(keys, { name, amountPaise, description, notes }) {
    const plan = await call(NAME, `${BASE}/plans`, {
      method: 'POST',
      headers: auth(keys),
      body: { period: 'monthly', interval: 1, item: { name, amount: amountPaise, currency: 'INR', description }, notes },
    });
    return { id: String(plan.id) };
  },

  // startAt: the first charge (e.g. the end of the free trial); without it, right after the
  // customer authorises. The customer pays on Razorpay's own page (short_url).
  async createSubscription(keys, { planId, startAt, notes }) {
    return normalize(await call(NAME, `${BASE}/subscriptions`, {
      method: 'POST',
      headers: auth(keys),
      body: { plan_id: planId, total_count: TOTAL_COUNT, quantity: 1, customer_notify: true, ...(startAt && { start_at: unix(startAt) }), notes },
    }));
  },

  async fetchSubscription(keys, id) {
    return normalize(await call(NAME, `${BASE}/subscriptions/${enc(id)}`, { headers: auth(keys) }));
  },

  // Another plan: now (an upgrade) or from the next cycle (a downgrade). Razorpay refuses this
  // for subscriptions paid by UPI or e-mandate; the caller says what to do then.
  async changePlan(keys, id, { planId, when }) {
    return normalize(await call(NAME, `${BASE}/subscriptions/${enc(id)}`, {
      method: 'PATCH',
      headers: auth(keys),
      body: { plan_id: planId, schedule_change_at: when === 'now' ? 'now' : 'cycle_end', customer_notify: true },
    }));
  },

  async cancelSubscription(keys, id, { atCycleEnd }) {
    return normalize(await call(NAME, `${BASE}/subscriptions/${enc(id)}/cancel`, {
      method: 'POST',
      headers: auth(keys),
      body: { cancel_at_cycle_end: Boolean(atCycleEnd) },
    }));
  },

  // The paid invoices of a subscription (for payments whose webhook did not arrive).
  async paidInvoices(keys, id) {
    const data = await call(NAME, `${BASE}/invoices?subscription_id=${enc(id)}&count=100`, { headers: auth(keys) });
    return (Array.isArray(data.items) ? data.items : [])
      .filter((invoice) => invoice.status === 'paid' && invoice.payment_id)
      .map((invoice) => ({
        paymentId: String(invoice.payment_id),
        invoiceId: String(invoice.id || ''),
        amountPaise: Number(invoice.amount_paid ?? invoice.amount) || 0,
        paidAt: fromUnix(invoice.paid_at) || fromUnix(invoice.created_at) || new Date(),
        periodStart: fromUnix(invoice.billing_start),
        periodEnd: fromUnix(invoice.billing_end),
      }));
  },

  verifyWebhook: ({ rawBody, headers, secret }) => payments.verifyWebhook({ rawBody, headers, secrets: { webhookSecret: secret } }),

  // → { eventId, event, subscription, payment? } or null (not a subscription event).
  parseWebhook(payload, headers = {}) {
    const event = String(payload?.event || '');
    if (!/^subscription\./.test(event)) return null;
    const sub = payload.payload?.subscription?.entity;
    if (!sub?.id) return null;
    const payment = payload.payload?.payment?.entity;
    return {
      eventId: String(headers['x-razorpay-event-id'] || `${event}:${sub.id}:${payment?.id || ''}`),
      event,
      subscription: normalize(sub),
      payment: captured(payment) ? normalizePayment(payment) : null,
    };
  },
};
