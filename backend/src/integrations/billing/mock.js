const crypto = require('crypto');
const env = require('../../config/env');
const httpError = require('../../utils/httpError');

// The test billing gateway (development and tests, never production): Razorpay Subscriptions'
// shapes without money. The customer "pays" on a page of this server
// (/api/v1/webhooks/billing-test/<id>), whose buttons produce the events Razorpay would send.
// Kept in memory: a restart forgets test subscriptions (the organizations keep their state).
const NAME = 'Test billing';
const subscriptions = new Map();

const randomId = (prefix) => `${prefix}${crypto.randomBytes(8).toString('hex')}`;
const amountOf = (planId) => Number(String(planId).split('_').pop()) || 0;
function addMonth(date) {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}
const copy = (sub) => ({ ...sub, notes: { ...sub.notes } });

function find(id) {
  const sub = subscriptions.get(String(id));
  if (!sub) throw httpError(400, 'PAYMENT_GATEWAY_ERROR', `${NAME}: this test subscription is gone (the server restarted). Choose the plan again.`);
  return sub;
}

// One month paid: the period moves on and an invoice is kept (what GET /invoices lists).
function charge(sub) {
  const start = sub.currentEnd && sub.currentEnd > new Date(Date.now() - 60000) ? sub.currentEnd : new Date();
  if (sub.scheduledPlanId) {
    sub.planId = sub.scheduledPlanId;
    sub.scheduledPlanId = '';
    sub.hasScheduledChanges = false;
  }
  sub.currentStart = start;
  sub.currentEnd = addMonth(start);
  sub.chargeAt = sub.currentEnd;
  sub.paidCount += 1;
  sub.status = 'active';
  const payment = { id: randomId('mock_pay_'), amountPaise: amountOf(sub.planId), method: 'card', paidAt: new Date(), invoiceId: randomId('mock_inv_') };
  sub.invoices.push({ paymentId: payment.id, invoiceId: payment.invoiceId, amountPaise: payment.amountPaise, paidAt: payment.paidAt, periodStart: sub.currentStart, periodEnd: sub.currentEnd });
  return payment;
}

const event = (sub, name, payment = null) => ({ eventId: randomId('mock_evt_'), event: name, subscription: copy(sub), payment });

module.exports = {
  name: NAME,

  async createPlan(keys, { amountPaise, notes }) {
    return { id: `mock_plan_${notes?.planKey || 'plan'}_${amountPaise}` };
  },

  async createSubscription(keys, { planId, startAt, notes }) {
    const id = randomId('mock_sub_');
    const sub = {
      id, planId, status: 'created', customerId: '', currentStart: null, currentEnd: null, chargeAt: startAt || null, startAt: startAt || null,
      endedAt: null, paidCount: 0, shortUrl: `${env.publicUrl}/api/v1/webhooks/billing-test/${id}`, hasScheduledChanges: false, notes: { ...notes },
      scheduledPlanId: '', cancelAtCycleEnd: false, invoices: [],
    };
    subscriptions.set(id, sub);
    return copy(sub);
  },

  async fetchSubscription(keys, id) {
    return copy(find(id));
  },

  async changePlan(keys, id, { planId, when }) {
    const sub = find(id);
    if (!['authenticated', 'active'].includes(sub.status)) throw httpError(400, 'PAYMENT_GATEWAY_ERROR', `${NAME}: only an authenticated or active subscription can change its plan.`);
    if (when === 'now') sub.planId = planId;
    else Object.assign(sub, { scheduledPlanId: planId, hasScheduledChanges: true });
    return copy(sub);
  },

  async cancelSubscription(keys, id, { atCycleEnd }) {
    const sub = find(id);
    if (atCycleEnd && sub.status === 'active') sub.cancelAtCycleEnd = true;
    else Object.assign(sub, { status: 'cancelled', endedAt: new Date() });
    return copy(sub);
  },

  async paidInvoices(keys, id) {
    return find(id).invoices.map((invoice) => ({ ...invoice }));
  },

  verifyWebhook: () => false,
  parseWebhook: () => null,

  // The test page: what it shows, and the events its buttons produce.
  get: (id) => (subscriptions.has(String(id)) ? copy(subscriptions.get(String(id))) : null),
  amountOf,
  act(id, action) {
    const sub = find(id);
    if (action === 'pay') {
      if (sub.status !== 'created') throw httpError(409, 'CONFLICT', 'This test subscription was already paid.');
      if (sub.startAt && sub.startAt > new Date()) {
        // A start later on (the rest of the trial): only the mandate now, the first charge then.
        sub.status = 'authenticated';
        return [event(sub, 'subscription.authenticated')];
      }
      const payment = charge(sub);
      return [event(sub, 'subscription.authenticated'), event(sub, 'subscription.activated'), event(sub, 'subscription.charged', payment)];
    }
    if (action === 'charge') {
      // A halted one is charged again when the customer fixes the card (Razorpay reactivates it).
      if (!['authenticated', 'active', 'pending', 'halted'].includes(sub.status)) throw httpError(409, 'CONFLICT', `A ${sub.status} test subscription is not charged.`);
      if (sub.cancelAtCycleEnd && sub.status === 'active') {
        Object.assign(sub, { status: 'cancelled', endedAt: new Date() });
        return [event(sub, 'subscription.cancelled')];
      }
      const wasActive = sub.status === 'active';
      const payment = charge(sub);
      return [...(wasActive ? [] : [event(sub, 'subscription.activated')]), event(sub, 'subscription.charged', payment)];
    }
    if (action === 'fail') {
      if (!['authenticated', 'active', 'pending'].includes(sub.status)) throw httpError(409, 'CONFLICT', `A ${sub.status} test subscription is not charged.`);
      sub.status = sub.status === 'pending' ? 'halted' : 'pending';
      return [event(sub, `subscription.${sub.status}`)];
    }
    throw httpError(400, 'VALIDATION_ERROR', 'Unknown test action.');
  },
};
