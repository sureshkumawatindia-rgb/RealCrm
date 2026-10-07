const env = require('../../config/env');
const httpError = require('../../utils/httpError');

// Sign-in codes on WhatsApp (Phase 10E) from the platform's own number, with an approved
// AUTHENTICATION template with a copy-code button. Checked 2026-10-07:
// https://developers.facebook.com/docs/whatsapp/business-management-api/authentication-templates/copy-code-button-authentication-templates
// The code goes twice: as the body's {{1}} and as the button's url parameter (index 0); at most
// 15 characters. The template's text is Meta's own ("<code> is your verification code.").
const TIMEOUT_MS = 15000;

async function sendCode({ phoneNumberId, accessToken, template, language }, phoneE164, code) {
  let response;
  try {
    response = await fetch(`${env.whatsapp.graphUrl}/${env.whatsapp.graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: String(phoneE164).replace(/^\+/, ''),
        type: 'template',
        template: {
          name: template,
          language: { code: language },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw httpError(502, 'OTP_NOT_SENT', 'Could not reach WhatsApp to send the code. Try again in a minute.');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = httpError(502, 'OTP_NOT_SENT', 'WhatsApp did not send the code. Try again, or sign in with Google.');
    error.providerMessage = data.error?.message || String(response.status);
    throw error;
  }
}

module.exports = { sendCode };
