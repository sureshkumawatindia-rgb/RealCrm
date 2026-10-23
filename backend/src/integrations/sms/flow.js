const httpError = require('../../utils/httpError');

// SMS to customers through the company's own MSG91 account (Phase 8A, D88). Checked
// 2026-10-22 (https://control.msg91.com/apidoc/textsms/send-sms-flow.php): POST
// https://control.msg91.com/api/v5/flow with the `authkey` header and
// { template_id, short_url, recipients: [{ mobiles: '91…', <blank>: value }] }; the answer is
// { type: 'success', message: <request id> } or { type: 'error', message }. In India the
// template must be DLT-approved. The delivery report's and inbound SMS's exact fields were not
// checked (UNVERIFIED), so parseWebhook reads the usual names loosely.
const FLOW_URL = 'https://control.msg91.com/api/v5/flow';
const BALANCE_URL = 'https://control.msg91.com/api/balance.php'; // UNVERIFIED: the old balance check
const TIMEOUT_MS = 15000;

async function send({ authKey, senderId }, { to, template, values }) {
  let response;
  let data = {};
  try {
    response = await fetch(FLOW_URL, {
      method: 'POST',
      headers: { authkey: authKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        template_id: template.flowId,
        short_url: '0',
        ...(senderId && { sender: senderId }),
        recipients: [{ mobiles: String(to).replace(/^\+/, ''), ...values }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    data = await response.json().catch(() => ({}));
  } catch {
    throw Object.assign(httpError(502, 'SMS_UNREACHABLE', 'Could not reach MSG91. It will be tried again.'), { retryable: true });
  }
  if (response.status === 401 || response.status === 403) throw httpError(400, 'SMS_AUTH', 'MSG91 refused the auth key. Check it in Settings → SMS.');
  if (!response.ok || data.type !== 'success') {
    const retryable = response.status >= 500;
    throw Object.assign(httpError(retryable ? 502 : 422, 'SMS_REFUSED', `MSG91 did not send it: ${data.message || `HTTP ${response.status}`}`), { retryable });
  }
  return { providerMessageId: String(data.message || data.request_id || '') || null, status: 'sent' };
}

async function test({ authKey }) {
  const url = new URL(BALANCE_URL);
  url.search = new URLSearchParams({ authkey: authKey, type: '4' }).toString();
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw httpError(502, 'SMS_UNREACHABLE', 'Could not reach MSG91.');
  }
  const text = await response.text();
  if (!response.ok || /invalid|error|auth/i.test(text)) throw httpError(400, 'SMS_AUTH', 'MSG91 did not accept the auth key.');
  return { ok: true };
}

const DELIVERED = /deliver/i;
const FAILED = /fail|reject|ndnc|block|invalid|expired|undeliv/i;
function statusOf(desc, code) {
  const text = String(desc || '');
  if (DELIVERED.test(text) || String(code) === '1') return 'delivered';
  if (FAILED.test(text) || ['2', '9', '16', '17', '25'].includes(String(code))) return 'failed';
  return 'sent';
}

// → { reports: [{ providerMessageId, status, error }], inbound: [{ from, text }] }
function parseWebhook(fields) {
  const reports = [];
  const inbound = [];
  const items = Array.isArray(fields?.data) ? fields.data : Array.isArray(fields) ? fields : [fields || {}];
  for (const item of items) {
    const id = item.requestId || item.request_id || item.requestID;
    if (id) {
      const lines = Array.isArray(item.report) ? item.report : [item];
      const last = lines.at(-1) || {};
      const status = statusOf(last.desc || last.status_desc || item.desc, last.status ?? item.status);
      reports.push({ providerMessageId: String(id), status, error: status === 'failed' ? String(last.desc || last.status || 'Failed') : '' });
    }
    const text = item.content ?? item.message ?? item.text;
    const from = item.sender || item.mobile || item.from || item.number;
    if (!id && text !== undefined && from) inbound.push({ from: String(from), text: String(text) });
  }
  return { reports, inbound };
}

module.exports = { name: 'msg91', send, test, parseWebhook, FLOW_URL };
