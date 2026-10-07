const crypto = require('crypto');
const env = require('../../config/env');
const httpError = require('../../utils/httpError');

// Meta Conversions API for CRM ("conversion leads"), checked 2026-10-07:
// https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/payload-specification
// POST /<dataset (pixel) id>/events { data: [event], test_event_code? } with a system user token.
// Each event: event_name = the CRM stage, event_time (unix seconds, at most 7 days old, after the
// lead was made), action_source "system_generated", user_data with at least one identifier
// (lead_id = the Lead Ads leadgen id, 15–17 digits; em / ph = SHA-256 of the normalised value),
// custom_data { event_source: "crm", lead_event_source: <the CRM's name> }.
// Same Graph API (and version) as WhatsApp; the token goes in a header, never in a URL.
const TIMEOUT_MS = 15000;
const LEAD_EVENT_SOURCE = 'YELLOW CRM';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function graph(path, { accessToken, method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${env.whatsapp.graphUrl}/${env.whatsapp.graphVersion}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw httpError(502, 'META_UNREACHABLE', 'Could not reach Meta. Check the internet connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const problem = data.error || {};
    throw httpError(response.status >= 500 ? 502 : 400, 'META_ERROR', `Meta: ${problem.error_user_msg || problem.message || `answered with status ${response.status}`}`);
  }
  return data;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
// Meta's normalisation: email trimmed and lower case; phone digits only with the country code.
const hashEmail = (email) => (email && /@/.test(email) ? sha256(String(email).trim().toLowerCase()) : null);
const hashPhone = (phoneE164) => {
  const digits = String(phoneE164 || '').replace(/\D/g, '');
  return digits.length >= 8 ? sha256(digits) : null;
};

// The dataset (pixel) the token can write to → its name.
async function checkDataset({ datasetId, accessToken }) {
  const data = await graph(`${encodeURIComponent(datasetId)}?fields=id,name`, { accessToken });
  return { id: String(data.id || datasetId), name: String(data.name || '') };
}

// lead: { stage, at, leadgenId?, email?, phoneE164? } → the event, or null without an identifier
// or when it is too old for Meta.
function eventOf({ stage, at, leadgenId, email, phoneE164 }, now = Date.now()) {
  const time = new Date(at || now).getTime();
  if (now - time > MAX_AGE_MS) return null;
  const userData = {};
  if (leadgenId && /^\d{15,17}$/.test(String(leadgenId))) userData.lead_id = String(leadgenId);
  const em = hashEmail(email);
  const ph = hashPhone(phoneE164);
  if (em) userData.em = [em];
  if (ph) userData.ph = [ph];
  if (!Object.keys(userData).length) return null;
  return {
    event_name: stage,
    event_time: Math.floor(time / 1000),
    action_source: 'system_generated',
    user_data: userData,
    custom_data: { event_source: 'crm', lead_event_source: LEAD_EVENT_SOURCE },
  };
}

// → { eventsReceived, traceId }
async function sendEvents({ datasetId, accessToken, testEventCode }, events) {
  const data = await graph(`${encodeURIComponent(datasetId)}/events`, {
    accessToken, method: 'POST', body: { data: events, ...(testEventCode && { test_event_code: testEventCode }) },
  });
  return { eventsReceived: Number(data.events_received) || 0, traceId: String(data.fbtrace_id || '') };
}

module.exports = { checkDataset, eventOf, sendEvents, hashEmail, hashPhone, LEAD_EVENT_SOURCE, MAX_AGE_MS };
