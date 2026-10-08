const logger = require('../../config/logger');
const env = require('../../config/env');
const httpError = require('../../utils/httpError');

// The SMS backup for login codes (2026-10-08): MSG91's OTP API with our own code. Checked
// 2026-10-08: POST https://control.msg91.com/api/v5/otp?template_id=&mobile=&otp=&otp_expiry=
// with the `authkey` header; the answer is { type: 'success', request_id } or
// { type: 'error', message } — an error can come with HTTP 200. In India the template must be
// DLT-approved (MSG91 links its template to the DLT one); its text holds ##OTP##.
const URL_BASE = 'https://control.msg91.com/api/v5/otp';
const TIMEOUT_MS = 15000;

async function sendCode({ authKey, templateId }, phoneE164, code, { expiryMinutes = 5 } = {}) {
  const url = new URL(URL_BASE);
  url.search = new URLSearchParams({
    template_id: templateId,
    mobile: String(phoneE164).replace(/^\+/, ''),
    otp: code,
    otp_length: String(code.length),
    otp_expiry: String(expiryMinutes),
  }).toString();
  let response;
  let data = {};
  try {
    response = await fetch(url, { method: 'POST', headers: { authkey: authKey, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    data = await response.json().catch(() => ({}));
  } catch {
    throw httpError(502, 'OTP_NOT_SENT', 'Could not reach the SMS service. Try again in a minute.');
  }
  if (!response.ok || data.type !== 'success') {
    // MSG91's reason helps whoever sets this up: always in the log, on the screen outside production.
    const reason = data.message || `HTTP ${response.status}`;
    logger.warn(`SMS login code not sent: ${reason}`);
    const error = httpError(502, 'OTP_NOT_SENT', env.isProduction ? 'The SMS was not sent. Try again in a minute.' : `The SMS was not sent: ${reason}`);
    error.providerMessage = reason;
    throw error;
  }
}

module.exports = { sendCode, URL_BASE };
