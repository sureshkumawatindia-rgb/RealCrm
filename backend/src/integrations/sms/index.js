const crypto = require('crypto');
const env = require('../../config/env');
const flow = require('./flow');

// SMS to customers behind one interface (Phase 8A, D88): send, test, parseWebhook. The test
// provider sends nothing; it can be told to fail (a refusal, or a provider outage that is retried)
// and reads the same webhook shapes. Offered only in tests and development.
let failures = [];
const sent = [];
const mock = {
  name: 'mock',
  async send(credentials, { to, template, values }) {
    const next = failures.shift();
    if (next) throw Object.assign(new Error(next.message || 'The test provider failed.'), { statusCode: next.retryable ? 502 : 422, code: 'SMS_REFUSED', retryable: Boolean(next.retryable) });
    const providerMessageId = `mock-sms-${crypto.randomBytes(6).toString('hex')}`;
    sent.push({ providerMessageId, to, flowId: template.flowId, values });
    return { providerMessageId, status: 'sent' };
  },
  async test() {
    return { ok: true };
  },
  parseWebhook: flow.parseWebhook,
  failNext: (...list) => { failures.push(...list); },
  sent: () => [...sent],
  reset: () => { failures = []; sent.length = 0; },
};

const PROVIDERS = { msg91: flow, mock };
const mockAllowed = () => env.isTest || env.devTools;
function providerFor(name) {
  if (name === 'mock' && !mockAllowed()) return null;
  if (env.isStaging && name !== 'mock') return null; // F2: no real SMS from staging
  return PROVIDERS[name] || null;
}

module.exports = { providerFor, mockAllowed, mock };
