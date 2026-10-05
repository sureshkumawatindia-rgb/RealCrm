const httpError = require('../../utils/httpError');

// A JSON call to a payment gateway. Keys go in headers only (never in a URL or a log line).
// Gateway refusals become 400 PAYMENT_GATEWAY_ERROR with the gateway's own words; a bad key
// becomes 401-like PAYMENT_KEYS_REFUSED (shown as "check the keys in Settings → Payments").
const TIMEOUT_MS = 15000;

async function call(name, url, { method = 'GET', headers = {}, body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw httpError(502, 'PAYMENT_GATEWAY_UNREACHABLE', `Could not reach ${name}. Check the internet connection and try again.`);
  }
  const data = await response.json().catch(() => ({}));
  if (response.ok) return data;
  // Razorpay: { error: { code, description } }; Cashfree: { message, code, type }.
  const said = data?.error?.description || data?.message || `${name} answered with status ${response.status}.`;
  if (response.status === 401 || response.status === 403) {
    const error = httpError(400, 'PAYMENT_KEYS_REFUSED', `${name} refused the keys: ${said}`);
    error.gatewayStatus = response.status;
    throw error;
  }
  const error = httpError(response.status >= 500 ? 502 : 400, 'PAYMENT_GATEWAY_ERROR', `${name}: ${said}`);
  error.gatewayStatus = response.status;
  throw error;
}

module.exports = { call };
