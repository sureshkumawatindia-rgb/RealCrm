const crypto = require('crypto');
const env = require('../../config/env');

// A stand-in for Meta's Graph API in tests (never used by the app itself): answers the calls
// "Connect WhatsApp" makes (D60) and records them. Usage:
//   const meta = fakeMeta.install({ wabaId, phoneNumberId, displayPhone });
//   ... meta.calls ... meta.restore();
// and fakeMeta.sign(body) signs a webhook body with the platform's app secret.
const APP = { appId: '1234567890', appSecret: 'test-meta-app-secret-0123456789', esConfigId: '9876543210', webhookVerifyToken: 'test-meta-verify-token' };

function enable() {
  const saved = { ...env.meta };
  Object.assign(env.meta, APP);
  return () => Object.assign(env.meta, saved);
}

function install({ wabaId = '1100000000001', phoneNumberId = '2200000000001', displayPhone = '+91 98290 10001', verifiedName = 'Shree Traders', token = 'EAAB-business-token-abcd' } = {}) {
  const calls = [];
  const state = { failCode: false, failSync: false };
  const original = global.fetch;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (!url.hostname.endsWith('facebook.com')) return original(input, options);
    const method = options.method || 'GET';
    const path = url.pathname.replace(/^\/v\d+\.\d+\//, '');
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
    calls.push({ method, path, query: Object.fromEntries(url.searchParams), body, auth: options.headers?.Authorization || '' });
    if (path === 'oauth/access_token') {
      return state.failCode || url.searchParams.get('code') === 'expired-code-0000'
        ? json({ error: { message: 'This authorization code has expired.', code: 100 } }, 400)
        : json({ access_token: token, token_type: 'bearer' });
    }
    if (path === `${wabaId}/phone_numbers`) {
      return json({ data: [{ id: phoneNumberId, display_phone_number: displayPhone, verified_name: verifiedName, quality_rating: 'GREEN' }] });
    }
    if (path === `${wabaId}/subscribed_apps`) return json({ success: true });
    if (path === `${phoneNumberId}/register`) return json({ success: true });
    if (path === `${phoneNumberId}/smb_app_data`) {
      return state.failSync ? json({ error: { message: 'Sync window has passed.', code: 100 } }, 400) : json({ success: true });
    }
    if (path === phoneNumberId) {
      return url.searchParams.get('fields')?.includes('messaging_limit')
        ? json({ whatsapp_business_manager_messaging_limit: 'TIER_1K' })
        : json({ display_phone_number: displayPhone, verified_name: verifiedName, quality_rating: 'GREEN' });
    }
    if (path === `${phoneNumberId}/messages`) return json({ messages: [{ id: `wamid.OUT${crypto.randomBytes(6).toString('hex')}` }] });
    return json({ error: { message: `Unexpected Graph call ${method} ${path}` } }, 404);
  };
  return { calls, state, token, wabaId, phoneNumberId, restore: () => { global.fetch = original; } };
}

const sign = (rawBody) => `sha256=${crypto.createHmac('sha256', APP.appSecret).update(rawBody).digest('hex')}`;

module.exports = { APP, enable, install, sign };
