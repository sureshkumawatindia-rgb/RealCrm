// Exotel click-to-call (Phase 6, D85). Checked 2026-10-22 on developer.exotel.com ("Make a call"):
// POST https://<subdomain>/v1/Accounts/<sid>/Calls/connect, HTTP Basic <api key>:<api token>,
// From (rung first: our member), To (the customer), CallerId (the ExoPhone), StatusCallback,
// StatusCallbackEvents[] (terminal, answered), StatusCallbackContentType; the answer is
// { Call: { Sid, Status, … } }. Record is always false: no recordings without a decision.
// The status callback's fields are not on that page (UNVERIFIED): parseStatus reads the Call
// object's names and the usual callback names, from JSON or a form.
const TIMEOUT_MS = 15000;

function failure(message, { status = 502, retry = false } = {}) {
  return Object.assign(new Error(message), { statusCode: status, code: 'TELEPHONY_FAILED', retry });
}

async function call(connection, path, { method = 'GET', form } = {}) {
  const url = `https://${connection.subdomain || 'api.exotel.com'}/v1/Accounts/${encodeURIComponent(connection.accountSid)}${path}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.apiKey}:${connection.apiToken}`).toString('base64')}`,
        Accept: 'application/json',
        ...(form && { 'Content-Type': 'application/x-www-form-urlencoded' }),
      },
      body: form ? form.toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw failure('Exotel did not answer.', { retry: true });
  }
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (response.status === 401 || response.status === 403) throw failure('Exotel refused the account SID, API key or token.', { status: 400 });
  if (!response.ok) throw failure(`Exotel answered ${response.status}${body?.RestException?.Message ? `: ${body.RestException.Message}` : ''}.`, { retry: response.status >= 500 });
  return body;
}

// Rings `from` (our member) first, then connects `to` (the customer).
async function connect(connection, { from, to, statusCallback }) {
  const form = new URLSearchParams({ From: from, To: to, CallerId: connection.callerId, Record: 'false', StatusCallback: statusCallback, StatusCallbackContentType: 'application/json' });
  form.append('StatusCallbackEvents[]', 'answered');
  form.append('StatusCallbackEvents[]', 'terminal');
  const body = await call(connection, '/Calls/connect', { method: 'POST', form });
  const sid = body?.Call?.Sid;
  if (!sid) throw failure('Exotel did not return a call id.');
  return { providerCallId: sid, status: mapStatus(body.Call.Status) || 'queued' };
}

// The account answers: the keys work.
async function test(connection) {
  await call(connection, '');
  return { ok: true };
}

const STATUS = { queued: 'queued', ringing: 'ringing', 'in-progress': 'in_progress', completed: 'completed', failed: 'failed', busy: 'busy', 'no-answer': 'no_answer', canceled: 'cancelled', cancelled: 'cancelled', answered: 'in_progress' };
const mapStatus = (value) => STATUS[String(value || '').toLowerCase()] || null;

// { providerCallId, status, durationSec, endedAt } from a callback (JSON or form fields).
function parseStatus(fields) {
  const get = (...names) => names.map((name) => fields[name]).find((value) => value !== undefined && value !== '');
  const sid = get('CallSid', 'Sid', 'call_sid');
  const duration = Number(get('ConversationDuration', 'Duration', 'DialCallDuration'));
  const ended = get('DateUpdated', 'EndTime');
  return {
    providerCallId: sid ? String(sid) : null,
    status: mapStatus(get('Status', 'CallStatus', 'EventType')),
    durationSec: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null,
    endedAt: ended && !Number.isNaN(Date.parse(ended)) ? new Date(ended) : null,
  };
}

module.exports = { name: 'exotel', connect, test, parseStatus, mapStatus };
