const crypto = require('crypto');

// A stand-in telephony provider (Phase 6, D85) for tests and development: connect answers with a
// call id (or fails when told to), and parseStatus reads the same fields as Exotel's adapter.
const { parseStatus } = require('./exotel');

let failures = [];
const placed = [];

async function connect(connection, { from, to, statusCallback }) {
  const next = failures.shift();
  if (next) throw Object.assign(new Error(next.message || 'The test provider failed.'), { statusCode: 502, code: 'TELEPHONY_FAILED', retry: Boolean(next.retry) });
  const providerCallId = `mock-call-${crypto.randomBytes(6).toString('hex')}`;
  placed.push({ providerCallId, from, to, statusCallback, callerId: connection.callerId });
  return { providerCallId, status: 'queued' };
}

async function test() {
  return { ok: true };
}

module.exports = {
  name: 'mock', connect, test, parseStatus,
  failNext: (...list) => { failures.push(...list); },
  placed: () => [...placed],
  reset: () => { failures = []; placed.length = 0; },
};
