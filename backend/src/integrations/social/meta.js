const env = require('../../config/env');
const httpError = require('../../utils/httpError');
const { graph } = require('../whatsapp/metaCloud');
const { PAGE_WEBHOOK_FIELDS } = require('../../constants/social');

// Instagram and Messenger through a Facebook Page (G8, D112), on graph.facebook.com — Meta's docs
// read 2026-11-02:
// https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages
// https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks
// https://developers.facebook.com/documentation/business-messaging/instagram-messaging/get-started
// Facebook Login for Business gives the page a code; here it becomes a long-lived user token, whose
// Pages' tokens do not expire (GET /me/accounts). The Page is subscribed to the app's webhook
// (POST /{page-id}/subscribed_apps); Messenger and its linked Instagram account are answered with
// POST /{page-id}/messages and the Page's token: RESPONSE within 24 hours of the customer's last
// message, else (a person, up to 7 days) MESSAGE_TAG with the HUMAN_AGENT tag.
const TIMEOUT_MS = 15000;
const enc = encodeURIComponent;

const available = () => Boolean(env.meta.appId && env.meta.appSecret && env.meta.socialConfigId);

async function oauth(params) {
  const url = new URL(`${env.whatsapp.graphUrl}/${env.whatsapp.graphVersion}/oauth/access_token`);
  url.search = new URLSearchParams({ client_id: env.meta.appId, client_secret: env.meta.appSecret, ...params }).toString();
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw httpError(502, 'META_UNREACHABLE', 'Could not reach Meta. Check the internet connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw httpError(400, 'SOCIAL_CONNECT_FAILED', `Meta did not accept the sign-in (it may have taken too long). Please connect again. ${data.error?.message || ''}`.trim());
  }
  return data.access_token;
}

module.exports = {
  available,

  // The popup's code → a long-lived user token (the app secret never leaves the server).
  async exchangeCode(code) {
    const token = await oauth({ code });
    return oauth({ grant_type: 'fb_exchange_token', fb_exchange_token: token });
  },

  // The Pages the person allowed: [{ id, name, accessToken, instagram: { id, username, name } | null }].
  async pages(userToken) {
    const data = await graph('me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name}&limit=100', { accessToken: userToken });
    return (Array.isArray(data.data) ? data.data : []).filter((page) => page?.id && page.access_token).map((page) => ({
      id: String(page.id),
      name: String(page.name || ''),
      accessToken: String(page.access_token),
      instagram: page.instagram_business_account?.id
        ? { id: String(page.instagram_business_account.id), username: String(page.instagram_business_account.username || ''), name: String(page.instagram_business_account.name || '') }
        : null,
    }));
  },

  async subscribePage({ pageId, accessToken }) {
    await graph(`${enc(pageId)}/subscribed_apps?subscribed_fields=${PAGE_WEBHOOK_FIELDS.join(',')}`, { accessToken, method: 'POST' });
  },
  async unsubscribePage({ pageId, accessToken }) {
    await graph(`${enc(pageId)}/subscribed_apps`, { accessToken, method: 'DELETE' });
  },

  // → { messageId }. humanAgent: a person's reply after 24 hours (Meta's HUMAN_AGENT tag).
  async sendText({ pageId, accessToken }, { channel, recipientId, text, humanAgent = false, replyToMid = '' }) {
    const data = await graph(`${enc(pageId)}/messages`, {
      accessToken,
      method: 'POST',
      body: {
        recipient: { id: recipientId },
        messaging_type: humanAgent ? 'MESSAGE_TAG' : 'RESPONSE',
        ...(humanAgent && { tag: 'HUMAN_AGENT' }),
        message: { text },
        ...(replyToMid && channel === 'messenger' && { reply_to: { mid: replyToMid } }),
      },
    });
    if (!data.message_id) throw httpError(502, 'META_ERROR', 'Meta did not return a message id.');
    return { messageId: String(data.message_id) };
  },

  // The customer's name (and Instagram @username), when Meta shares it. Never stops a message.
  async profile({ accessToken }, { channel, userId }) {
    const fields = channel === 'instagram' ? 'name,username' : 'first_name,last_name';
    const data = await graph(`${enc(userId)}?fields=${fields}`, { accessToken });
    const name = channel === 'instagram' ? data.name : [data.first_name, data.last_name].filter(Boolean).join(' ');
    return { name: String(name || '').trim(), username: String(data.username || '') };
  },
};
