const env = require('../../config/env');

// IndiaMART Lead Manager CRM API (checked 2026-09-29):
// https://help.indiamart.com/knowledge-base/lms-crm-integration-v2 (Pull API v2)
// https://help.indiamart.com/knowledge-base/integration-of-indiamarts-lead-manager-crm-push-api-with-third-party-crms-real-time-push-of-leads
// Pull: GET <url>?glusr_crm_key=<key>&start_time=&end_time= (IST, "DD-MM-YYYYHH:MM:SS"), at most a
// 7-day window, one call per 5 minutes (more than 5 calls a minute blocks the key for 15 minutes),
// the last 365 days only, and a key expires after 7 days without use. The answer is always JSON
// { CODE, STATUS, MESSAGE, TOTAL_RECORDS, RESPONSE[] }; CODE 204 means "no leads".
// Push: IndiaMART POSTs { CODE, STATUS, RESPONSE: { ...one lead } } to our HTTPS URL and retries until
// it gets HTTP 200 (it stops after 48 hours of failures). There is no signature.
const TIMEOUT_MS = 20000;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// QUERY_TYPE → what the team sees.
const QUERY_TYPES = Object.freeze({
  W: 'Direct enquiry',
  B: 'Buy-lead',
  P: 'Phone call (PNS)',
  WA: 'WhatsApp enquiry',
  BIZ: 'Catalogue view',
});
// Catalogue views are only "someone looked at your catalogue", so they are off unless chosen.
const DEFAULT_QUERY_TYPES = Object.freeze(['W', 'B', 'P', 'WA']);

const pad = (n) => String(n).padStart(2, '0');
// A moment as IndiaMART's IST timestamp "DD-MM-YYYYHH:MM:SS".
function formatIst(date) {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return `${pad(ist.getUTCDate())}-${pad(ist.getUTCMonth() + 1)}-${ist.getUTCFullYear()}${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`;
}

// QUERY_TIME is IST, e.g. "2026-09-29 14:05:09"; anything unreadable counts as "now".
function parseQueryTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value || '').trim());
  if (!match) return new Date();
  const [, y, mo, d, h, mi, s = '00'] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+05:30`);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

// The part of a pull to ask for: from 5 minutes before the last end (IndiaMART's own advice, so
// nothing on the boundary is missed) to now, never longer than 7 days.
function pullWindow(lastEndTime, now = new Date()) {
  const end = now;
  let start = lastEndTime ? new Date(new Date(lastEndTime).getTime() - MIN_INTERVAL_MS) : new Date(end.getTime() - 24 * 60 * 60 * 1000);
  let gap = false;
  if (end.getTime() - start.getTime() > MAX_WINDOW_MS) {
    start = new Date(end.getTime() - MAX_WINDOW_MS + 60 * 1000);
    gap = Boolean(lastEndTime);
  }
  return { start, end, gap };
}

async function fetchLeads({ apiKey, start, end }) {
  const url = new URL(env.leadSources.indiamartUrl);
  url.searchParams.set('glusr_crm_key', apiKey);
  url.searchParams.set('start_time', formatIst(start));
  url.searchParams.set('end_time', formatIst(end));
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { code: 0, message: 'Could not reach IndiaMART. The next pull tries again.', leads: [] };
  }
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object') return { code: response.status || 0, message: `IndiaMART answered with status ${response.status}.`, leads: [] };
  const code = Number(body.CODE) || response.status;
  const leads = Array.isArray(body.RESPONSE) ? body.RESPONSE : body.RESPONSE && typeof body.RESPONSE === 'object' ? [body.RESPONSE] : [];
  return { code, message: String(body.MESSAGE || ''), leads };
}

// One IndiaMART lead → the lead intake's input.
function toIntake(lead) {
  const type = String(lead.QUERY_TYPE || '').toUpperCase();
  const label = QUERY_TYPES[type] || 'Enquiry';
  const name = String(lead.SENDER_NAME || '').trim();
  const pieces = [label];
  if (type === 'P' && lead.CALL_DURATION) pieces.push(`call duration ${lead.CALL_DURATION}`);
  const message = String(lead.QUERY_MESSAGE || lead.SUBJECT || '').replace(/[\r\b]/g, '').replace(/\t/g, ' ').trim();
  return {
    type,
    sourceRef: String(lead.UNIQUE_QUERY_ID || '').trim(),
    receivedAt: parseQueryTime(lead.QUERY_TIME),
    person: {
      name: name && name !== 'IndiaMART Buyer' ? name : String(lead.SENDER_COMPANY || '').trim() || name,
      phone: lead.SENDER_MOBILE || lead.SENDER_MOBILE_ALT || lead.SENDER_PHONE || lead.SENDER_PHONE_ALT || '',
      email: lead.SENDER_EMAIL || lead.SENDER_EMAIL_ALT || '',
      company: lead.SENDER_COMPANY || '',
      city: lead.SENDER_CITY || '',
      state: lead.SENDER_STATE || '',
      address: [lead.SENDER_ADDRESS, lead.SENDER_PINCODE].filter(Boolean).join(' '),
    },
    enquiry: {
      product: lead.QUERY_PRODUCT_NAME || lead.QUERY_MCAT_NAME || '',
      message: message ? `${pieces.join(', ')}: ${message}` : pieces.join(', '),
    },
  };
}

module.exports = {
  QUERY_TYPES, DEFAULT_QUERY_TYPES, MIN_INTERVAL_MS, MAX_WINDOW_MS, formatIst, parseQueryTime, pullWindow, fetchLeads, toIntake,
};
