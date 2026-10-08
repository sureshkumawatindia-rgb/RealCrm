const env = require('../../config/env');
const httpError = require('../../utils/httpError');
const { graph } = require('./metaCloud');

// "Connect WhatsApp" (D60): Meta's Embedded Signup for a Tech Provider, with WhatsApp Business
// app coexistence. Checked 2026-10-08 against
// https://developers.facebook.com/docs/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
// https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/
// 1. The popup gives the page a code (valid 30 seconds) → exchanged here, server to server, for a
//    business token (the app secret never leaves the server; the URL is never logged).
// 2. The WABA's numbers (the coexistence FINISH event names only the WABA).
// 3. Subscribe our app to the WABA's webhooks.
// 4. A new number is registered (6-digit PIN); a WhatsApp Business app number is not (it is
//    registered already) — instead its contacts, then its history, are asked for within 24 hours.
const TIMEOUT_MS = 15000;
const enc = encodeURIComponent;

const available = () => Boolean(env.meta.appId && env.meta.appSecret && env.meta.esConfigId);

async function exchangeCode(code) {
  const url = new URL(`${env.whatsapp.graphUrl}/${env.whatsapp.graphVersion}/oauth/access_token`);
  url.search = new URLSearchParams({ client_id: env.meta.appId, client_secret: env.meta.appSecret, code }).toString();
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw httpError(502, 'WHATSAPP_UNREACHABLE', 'Could not reach Meta. Check the internet connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const error = httpError(400, 'WHATSAPP_CONNECT_FAILED', 'Meta did not accept this sign-up (it may have taken too long). Please connect again.');
    error.providerMessage = data.error?.message || `HTTP ${response.status}`;
    throw error;
  }
  return data.access_token;
}

// [{ phoneNumberId, displayPhone, verifiedName, qualityRating }]
async function phoneNumbersOf({ wabaId, accessToken }) {
  const data = await graph(`${enc(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`, { accessToken });
  return (Array.isArray(data.data) ? data.data : []).map((number) => ({
    phoneNumberId: String(number.id || ''),
    displayPhone: number.display_phone_number || '',
    verifiedName: number.verified_name || '',
    qualityRating: number.quality_rating || '',
  })).filter((number) => number.phoneNumberId);
}

async function subscribeApp({ wabaId, accessToken }) {
  await graph(`${enc(wabaId)}/subscribed_apps`, { accessToken, method: 'POST' });
}

async function registerNumber({ phoneNumberId, accessToken, pin }) {
  await graph(`${enc(phoneNumberId)}/register`, { accessToken, method: 'POST', body: { messaging_product: 'whatsapp', pin } });
}

// syncType: 'smb_app_state_sync' (contacts) or 'history' (chats of the last 6 months).
async function startSync({ phoneNumberId, accessToken, syncType }) {
  return graph(`${enc(phoneNumberId)}/smb_app_data`, { accessToken, method: 'POST', body: { messaging_product: 'whatsapp', sync_type: syncType } });
}

module.exports = { available, exchangeCode, phoneNumbersOf, subscribeApp, registerNumber, startSync };
