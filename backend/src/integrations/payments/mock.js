const crypto = require('crypto');
const env = require('../../config/env');

// Stand-in gateway while there are no Razorpay/Cashfree keys (development and tests only; the
// server refuses it in production). Its links open a small "test payment" page on this server
// (routes/webhooks.js); paying there goes through the same processing as a real webhook.
const STATUSES = new Set(['created', 'partially_paid', 'paid', 'expired', 'cancelled']);

const testPayUrl = (providerLinkId) => `${env.publicUrl}/api/v1/webhooks/payments-test/${providerLinkId}`;

module.exports = {
  name: 'Test gateway',
  modeOf: () => 'test',

  async checkKeys() {
    return { mode: 'test' };
  },

  async createLink(credentials, input) {
    const providerLinkId = `mock_plink_${crypto.randomBytes(12).toString('hex')}`;
    return { providerLinkId, shortUrl: testPayUrl(providerLinkId), status: 'created', amountPaidPaise: 0, expiresAt: input.expiresAt, payments: [] };
  },

  // The test gateway keeps nothing itself: what the CRM stored is the whole story.
  async fetchLink() {
    return null;
  },

  async cancelLink(credentials, providerLinkId) {
    return { providerLinkId, status: 'cancelled', payments: [] };
  },

  // Nobody outside calls the test gateway's webhook.
  verifyWebhook() {
    return false;
  },

  // The event the test payment page makes (Razorpay-like, so it reads the same way).
  paymentEvent(link, amountPaise) {
    const paid = (link.amountPaidPaise || 0) + amountPaise;
    const providerPaymentId = `mock_pay_${crypto.randomBytes(10).toString('hex')}`;
    return {
      event: paid >= link.amountPaise ? 'payment_link.paid' : 'payment_link.partially_paid',
      providerLinkId: link.providerLinkId,
      status: paid >= link.amountPaise ? 'paid' : 'partially_paid',
      amountPaidPaise: paid,
      payment: { providerPaymentId, amountPaise, method: 'upi', paidAt: new Date().toISOString() },
    };
  },

  parseWebhook(payload) {
    if (!payload?.providerLinkId || !STATUSES.has(payload.status)) return null;
    const payment = payload.payment ? { ...payload.payment, paidAt: new Date(payload.payment.paidAt) } : null;
    return { eventId: `${payload.providerLinkId}:${payment?.providerPaymentId || payload.status}`, providerLinkId: payload.providerLinkId, status: payload.status, amountPaidPaise: payload.amountPaidPaise, payment };
  },

  testPayUrl,
};
