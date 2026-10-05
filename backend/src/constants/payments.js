// Payments (Phase 8): payment gateways, payment links and what an order has been paid.

// "mock": a stand-in gateway for development without keys (never allowed in production).
const PAYMENT_PROVIDERS = Object.freeze({
  razorpay: 'Razorpay',
  cashfree: 'Cashfree',
  mock: 'Test gateway',
});
const PAYMENT_PROVIDER_KEYS = Object.freeze(Object.keys(PAYMENT_PROVIDERS));
const CONNECTION_STATUSES = Object.freeze(['connected', 'error']);

// A payment link's life (the gateways' statuses mapped to ours).
const LINK_STATUSES = Object.freeze(['created', 'partially_paid', 'paid', 'expired', 'cancelled']);
const OPEN_LINK_STATUSES = Object.freeze(['created', 'partially_paid']);

// How a payment recorded by hand on an order was made.
const MANUAL_PAYMENT_METHODS = Object.freeze(['cash', 'bank_transfer', 'upi', 'cheque', 'card', 'other']);
const ORDER_PAYMENT_STATUSES = Object.freeze(['unpaid', 'partly_paid', 'paid']);

// Gateways take at least ₹1; a link lives 15 minutes to 180 days (Razorpay's limits are the
// tighter ones: at least 15 minutes ahead, at most 6 months).
const MIN_LINK_PAISE = 100;
const DEFAULT_EXPIRY_DAYS = 7;
const MAX_EXPIRY_DAYS = 180;

module.exports = {
  PAYMENT_PROVIDERS, PAYMENT_PROVIDER_KEYS, CONNECTION_STATUSES, LINK_STATUSES, OPEN_LINK_STATUSES,
  MANUAL_PAYMENT_METHODS, ORDER_PAYMENT_STATUSES, MIN_LINK_PAISE, DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS,
};
