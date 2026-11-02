const env = require('../../config/env');
const httpError = require('../../utils/httpError');

// WhatsApp Cloud API client (Meta Graph API, version WHATSAPP_GRAPH_VERSION).
// https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
// https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
// https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/template-api
// The access token goes in the Authorization header only (never in a URL or a log line).
const TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const TEMPLATE_FIELDS = 'id,name,language,status,category,components,parameter_format,rejected_reason,quality_score';
const TEMPLATE_PAGES = 20; // 100 per page

const unreachable = () => httpError(502, 'WHATSAPP_UNREACHABLE', 'Could not reach WhatsApp (Meta). Check the internet connection and try again.');

// body: a JSON object, or FormData for uploads.
async function graph(path, { accessToken, method = 'GET', body, timeoutMs = TIMEOUT_MS } = {}) {
  const url = `${env.whatsapp.graphUrl}/${env.whatsapp.graphVersion}/${path}`;
  const isForm = body instanceof FormData;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body && !isForm && { 'Content-Type': 'application/json' }) },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw unreachable();
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // { error: { message, type, code, error_user_msg, error_data: { details }, fbtrace_id } }
    const problem = data.error || {};
    const error = httpError(
      response.status >= 500 ? 502 : 400,
      'WHATSAPP_ERROR',
      problem.error_user_msg || problem.error_data?.details || problem.message || `WhatsApp answered with status ${response.status}.`,
    );
    error.providerCode = problem.code;
    throw error;
  }
  return data;
}

// Our shape of a template from the Template API.
function normalizeTemplate(template) {
  const quality = template.quality_score;
  return {
    providerTemplateId: String(template.id || ''),
    name: String(template.name || ''),
    language: String(template.language || ''),
    status: String(template.status || '').toUpperCase(),
    category: String(template.category || '').toUpperCase(),
    parameterFormat: String(template.parameter_format || '').toUpperCase() === 'NAMED' ? 'NAMED' : 'POSITIONAL',
    components: Array.isArray(template.components) ? template.components : [],
    rejectedReason: template.rejected_reason && template.rejected_reason !== 'NONE' ? String(template.rejected_reason) : '',
    qualityScore: String((quality && typeof quality === 'object' ? quality.score : quality) || ''),
  };
}

const enc = encodeURIComponent;

module.exports = {
  // Checks the phone number id and the token, and returns what Meta knows about the number.
  async getPhoneNumber({ phoneNumberId, accessToken }) {
    const data = await graph(`${enc(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`, { accessToken });
    // Meta's daily limit (the business portfolio's; TIER_250 … TIER_UNLIMITED). Asked separately
    // so an older API version without the field never breaks the connection check.
    const limit = await graph(`${enc(phoneNumberId)}?fields=whatsapp_business_manager_messaging_limit`, { accessToken }).catch(() => ({}));
    return {
      displayPhone: data.display_phone_number || '',
      verifiedName: data.verified_name || '',
      qualityRating: data.quality_rating || '',
      messagingLimit: String(limit.whatsapp_business_manager_messaging_limit || ''),
    };
  },

  // body: the Cloud API message object without messaging_product. Returns Meta's message id.
  async sendMessage({ phoneNumberId, accessToken }, body) {
    const data = await graph(`${enc(phoneNumberId)}/messages`, {
      accessToken,
      method: 'POST',
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...body },
    });
    return { providerMessageId: data.messages?.[0]?.id || null };
  },

  // Blue ticks on a message the customer sent; typing also shows "typing…" to the customer until
  // we answer or for 25 seconds (Cloud API typing indicators, checked 2026-10-12).
  async markRead({ phoneNumberId, accessToken }, { messageId, typing = false }) {
    await graph(`${enc(phoneNumberId)}/messages`, {
      accessToken,
      method: 'POST',
      body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId, ...(typing && { typing_indicator: { type: 'text' } }) },
    });
    return { success: true };
  },

  // --- templates (per WhatsApp Business Account) ---
  async listTemplates({ wabaId, accessToken }) {
    const templates = [];
    let after = '';
    for (let page = 0; page < TEMPLATE_PAGES; page += 1) {
      const data = await graph(`${enc(wabaId)}/message_templates?fields=${TEMPLATE_FIELDS}&limit=100${after ? `&after=${enc(after)}` : ''}`, { accessToken });
      templates.push(...(Array.isArray(data.data) ? data.data : []));
      after = data.paging?.next ? data.paging?.cursors?.after || '' : '';
      if (!after) break;
    }
    return templates.map(normalizeTemplate);
  },

  // body: { name, language, category, parameter_format, components }. Meta answers { id, status, category }.
  async createTemplate({ wabaId, accessToken }, body) {
    const data = await graph(`${enc(wabaId)}/message_templates`, { accessToken, method: 'POST', body });
    return { providerTemplateId: String(data.id || ''), status: String(data.status || 'PENDING').toUpperCase(), category: String(data.category || body.category) };
  },

  // With hsm_id only this language of the template is deleted (name alone deletes every language).
  async deleteTemplate({ wabaId, accessToken }, { name, providerTemplateId }) {
    await graph(`${enc(wabaId)}/message_templates?name=${enc(name)}${providerTemplateId ? `&hsm_id=${enc(providerTemplateId)}` : ''}`, { accessToken, method: 'DELETE' });
  },

  // --- the catalog (Meta Commerce, Phase 8C) ---
  // https://developers.facebook.com/docs/marketing-api/catalog-batch/reference — POST /{catalog}/items_batch
  // https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/sell-products-and-services/set-commerce-settings
  // The token's system user needs the catalog assigned to it (catalog_management).
  async getCatalog({ accessToken }, catalogId) {
    const data = await graph(`${enc(catalogId)}?fields=id,name,product_count`, { accessToken });
    return { catalogId: String(data.id || catalogId), name: String(data.name || ''), productCount: Number(data.product_count) || 0 };
  },

  // requests: [{ method: CREATE | UPDATE | DELETE, data: { id, … } }] (at most 5000; we send ≤ 1000).
  // Returns Meta's per-item problems: [{ retailerId, message }].
  async catalogBatch({ accessToken }, catalogId, requests) {
    const data = await graph(`${enc(catalogId)}/items_batch`, { accessToken, method: 'POST', body: { item_type: 'PRODUCT_ITEM', requests }, timeoutMs: DOWNLOAD_TIMEOUT_MS });
    const problems = (Array.isArray(data.validation_status) ? data.validation_status : [])
      .filter((v) => Array.isArray(v?.errors) && v.errors.length)
      .map((v) => ({ retailerId: String(v.retailer_id || ''), message: String(v.errors[0]?.message || 'Refused by Meta') }));
    return { handles: Array.isArray(data.handles) ? data.handles : [], problems };
  },

  // Shows the catalog (shop button) and lets customers send a cart from this number.
  async setCommerceSettings({ phoneNumberId, accessToken }, { catalogVisible, cartEnabled }) {
    await graph(`${enc(phoneNumberId)}/whatsapp_commerce_settings?is_catalog_visible=${catalogVisible ? 'true' : 'false'}&is_cart_enabled=${cartEnabled ? 'true' : 'false'}`, { accessToken, method: 'POST' });
  },

  // --- media ---
  // Uploads a file for sending; the media id is valid for 30 days.
  async uploadMedia({ phoneNumberId, accessToken }, { buffer, mimeType, fileName }) {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([buffer], { type: mimeType }), fileName);
    const data = await graph(`${enc(phoneNumberId)}/media`, { accessToken, method: 'POST', body: form, timeoutMs: DOWNLOAD_TIMEOUT_MS });
    if (!data.id) throw httpError(502, 'WHATSAPP_ERROR', 'WhatsApp did not return a media id.');
    return { mediaId: String(data.id) };
  },

  // D103: block or unblock customers on this number (Cloud API block_users, read 2026-10-29):
  // only people who wrote in the last 24 hours; up to 1,000 a call. → { done, failed } per user.
  async blockUsers({ phoneNumberId, accessToken }, users, { unblock = false } = {}) {
    const data = await graph(`${enc(phoneNumberId)}/block_users`, {
      accessToken,
      method: unblock ? 'DELETE' : 'POST',
      body: { messaging_product: 'whatsapp', block_users: users.map((user) => ({ user })) },
    });
    const result = data.block_users || {};
    return { done: (unblock ? result.removed_users : result.added_users) || [], failed: result.failed_users || [] };
  },

  // --- WhatsApp Flows (G6, D110): forms inside WhatsApp, made on the WhatsApp Business Account ---
  // https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/reference/flowsapi
  // (read 2026-11-02): POST /{waba}/flows { name, categories, flow_json (a string), publish } makes
  // the Flow and, when its JSON is valid, publishes it at once (Meta answers { id, success,
  // validation_errors }); GET /{flow}?fields=status says whether it is PUBLISHED. A published Flow
  // cannot change: it is retired with POST /{flow}/deprecate; a draft can be deleted.
  async createFlow({ wabaId, accessToken }, { name, categories, flowJson }) {
    const data = await graph(`${enc(wabaId)}/flows`, { accessToken, method: 'POST', body: { name, categories, flow_json: JSON.stringify(flowJson), publish: true } });
    const problems = (Array.isArray(data.validation_errors) ? data.validation_errors : []).map((e) => String(e?.message || e?.error || 'Invalid')).slice(0, 5);
    const flowId = String(data.id || '');
    const status = flowId ? String((await graph(`${enc(flowId)}?fields=status`, { accessToken })).status || 'DRAFT').toUpperCase() : 'DRAFT';
    return { flowId, status, problems };
  },
  async deprecateFlow({ accessToken }, flowId) {
    await graph(`${enc(flowId)}/deprecate`, { accessToken, method: 'POST' });
  },
  async deleteFlow({ accessToken }, flowId) {
    await graph(enc(flowId), { accessToken, method: 'DELETE' });
  },

  // --- WhatsApp calls (G7, D111) ---
  // https://developers.facebook.com/documentation/business-messaging/whatsapp/calling (read
  // 2026-11-02; India allowed for customer and business calls): calling is switched on per number
  // with POST /{phone-number-id}/settings. A customer's call is answered with pre_accept, then
  // accept (our SDP answer, the same both times), declined with reject and ended with terminate;
  // a business call is made with connect (our SDP offer) once the customer gave permission —
  // all POST /{phone-number-id}/calls. Meta answers { success: true }, or { calls: [{ id }] }.
  async setCalling({ phoneNumberId, accessToken }, { enabled, callbackPermission }) {
    const calling = enabled
      ? { status: 'ENABLED', call_icon_visibility: 'DEFAULT', callback_permission_status: callbackPermission ? 'ENABLED' : 'DISABLED' }
      : { status: 'DISABLED' };
    await graph(`${enc(phoneNumberId)}/settings`, { accessToken, method: 'POST', body: { calling } });
  },
  async callAction({ phoneNumberId, accessToken }, { callId, action, sdp }) {
    await graph(`${enc(phoneNumberId)}/calls`, {
      accessToken,
      method: 'POST',
      body: { messaging_product: 'whatsapp', call_id: callId, action, ...(sdp && { session: { sdp_type: 'answer', sdp } }) },
    });
  },
  // to: the customer's wa_id; tag: comes back in the call's webhooks (biz_opaque_callback_data).
  async startCall({ phoneNumberId, accessToken }, { to, sdp, tag }) {
    const data = await graph(`${enc(phoneNumberId)}/calls`, {
      accessToken,
      method: 'POST',
      body: { messaging_product: 'whatsapp', to, action: 'connect', session: { sdp_type: 'offer', sdp }, ...(tag && { biz_opaque_callback_data: tag }) },
    });
    const callId = String(data.calls?.[0]?.id || '');
    if (!callId) throw httpError(502, 'WHATSAPP_ERROR', 'WhatsApp did not return a call id.');
    return { callId };
  },

  // A received file's details and a download URL (valid 5 minutes).
  async getMedia({ phoneNumberId, accessToken }, mediaId) {
    const data = await graph(`${enc(mediaId)}?phone_number_id=${enc(phoneNumberId)}`, { accessToken });
    return { url: data.url || '', mimeType: data.mime_type || '', sha256: data.sha256 || '', sizeBytes: Number(data.file_size) || null };
  },

  // The file itself (the URL needs the same token). Stops at maxBytes.
  async downloadMedia({ accessToken }, url, { maxBytes }) {
    if (!/^https:\/\//i.test(url)) throw httpError(502, 'WHATSAPP_ERROR', 'WhatsApp gave an unexpected download address.');
    let response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch {
      throw unreachable();
    }
    if (!response.ok) throw httpError(response.status === 404 ? 404 : 502, 'MEDIA_UNAVAILABLE', 'WhatsApp no longer has this file.');
    if (Number(response.headers.get('content-length')) > maxBytes) throw httpError(413, 'FILE_TOO_LARGE', 'This file is too big to keep in the CRM.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw httpError(413, 'FILE_TOO_LARGE', 'This file is too big to keep in the CRM.');
    return { buffer, mimeType: response.headers.get('content-type') || '' };
  },
};

module.exports.normalizeTemplate = normalizeTemplate;
module.exports.graph = graph; // integrations/whatsapp/embeddedSignup.js
