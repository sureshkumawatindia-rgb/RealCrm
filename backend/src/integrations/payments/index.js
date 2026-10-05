const razorpay = require('./razorpay');
const cashfree = require('./cashfree');
const mock = require('./mock');

// Payment gateways behind one interface (Phase 8): checkKeys, createLink, fetchLink, cancelLink,
// verifyWebhook, parseWebhook. Links, payments and statuses come back in the same shape.
const PROVIDERS = { razorpay, cashfree, mock };

function gatewayFor(provider) {
  const gateway = PROVIDERS[provider];
  if (!gateway) throw new Error(`Unknown payment gateway: ${provider}`);
  return gateway;
}

module.exports = { gatewayFor };
