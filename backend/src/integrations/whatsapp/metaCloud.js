const env = require('../../config/env');
const httpError = require('../../utils/httpError');

// WhatsApp Cloud API client (Meta Graph API, version WHATSAPP_GRAPH_VERSION).
// https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
// The access token goes in the Authorization header only (never in a URL or a log line).
const TIMEOUT_MS = 15000;

async function graph(path, { accessToken, method = 'GET', body } = {}) {
  const url = `${env.whatsapp.graphUrl}/${env.whatsapp.graphVersion}/${path}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw httpError(502, 'WHATSAPP_UNREACHABLE', 'Could not reach WhatsApp (Meta). Check the internet connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // { error: { message, type, code, error_data: { details }, fbtrace_id } }
    const problem = data.error || {};
    const error = httpError(
      response.status >= 500 ? 502 : 400,
      'WHATSAPP_ERROR',
      problem.error_data?.details || problem.message || `WhatsApp answered with status ${response.status}.`,
    );
    error.providerCode = problem.code;
    throw error;
  }
  return data;
}

module.exports = {
  // Checks the phone number id and the token, and returns what Meta knows about the number.
  async getPhoneNumber({ phoneNumberId, accessToken }) {
    const data = await graph(`${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`, { accessToken });
    return {
      displayPhone: data.display_phone_number || '',
      verifiedName: data.verified_name || '',
      qualityRating: data.quality_rating || '',
    };
  },

  // body: the Cloud API message object without messaging_product. Returns Meta's message id.
  async sendMessage({ phoneNumberId, accessToken }, body) {
    const data = await graph(`${encodeURIComponent(phoneNumberId)}/messages`, {
      accessToken,
      method: 'POST',
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...body },
    });
    return { providerMessageId: data.messages?.[0]?.id || null };
  },
};
