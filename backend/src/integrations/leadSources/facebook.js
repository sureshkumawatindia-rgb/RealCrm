const env = require('../../config/env');
const httpError = require('../../utils/httpError');

// Facebook (Meta) Lead Ads, checked 2026-09-29:
// https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-leadgen/
// https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/retrieving
// The Page's "leadgen" webhook only says a lead exists ({ leadgen_id, page_id, form_id, ad_id,
// created_time }); the lead itself is read with GET /<leadgen_id> and a (long-lived) Page access
// token with leads_retrieval, pages_manage_metadata, pages_show_list, pages_read_engagement and
// ads_management. The Page is subscribed with POST /<page_id>/subscribed_apps?subscribed_fields=leadgen.
// Same Graph API (and version) as WhatsApp; webhooks are signed with X-Hub-Signature-256.
const TIMEOUT_MS = 15000;

async function graph(path, { accessToken, method = 'GET' } = {}) {
  let response;
  try {
    response = await fetch(`${env.whatsapp.graphUrl}/${env.whatsapp.graphVersion}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw httpError(502, 'FACEBOOK_UNREACHABLE', 'Could not reach Facebook. Check the internet connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const problem = data.error || {};
    const error = httpError(response.status >= 500 ? 502 : 400, 'FACEBOOK_ERROR', problem.error_user_msg || problem.message || `Facebook answered with status ${response.status}.`);
    error.providerCode = problem.code;
    throw error;
  }
  return data;
}

const enc = encodeURIComponent;

// Checks the token against the Page; returns the Page's name.
async function getPage({ pageId, accessToken }) {
  const data = await graph(`${enc(pageId)}?fields=id,name`, { accessToken });
  return { id: String(data.id || pageId), name: String(data.name || '') };
}

// Makes Facebook send this Page's new leads to the app's webhook.
async function subscribePage({ pageId, accessToken }) {
  const data = await graph(`${enc(pageId)}/subscribed_apps?subscribed_fields=leadgen`, { accessToken, method: 'POST' });
  if (data.success === false) throw httpError(400, 'FACEBOOK_ERROR', 'Facebook did not subscribe the Page to lead notifications.');
}

async function getLead({ accessToken }, leadgenId) {
  return graph(`${enc(leadgenId)}?fields=id,created_time,ad_id,form_id,field_data`, { accessToken });
}

async function getFormName({ accessToken }, formId) {
  const data = await graph(`${enc(formId)}?fields=name`, { accessToken });
  return String(data.name || '');
}

// Standard Lead Ads questions → the lead intake; custom questions go into the message.
const STANDARD = {
  full_name: 'name', first_name: 'first', last_name: 'last', email: 'email', work_email: 'email', phone_number: 'phone',
  work_phone_number: 'phone', city: 'city', state: 'state', province: 'state', company_name: 'company', street_address: 'address',
  zip_code: 'postcode', post_code: 'postcode',
};

function toIntake(lead, formName = '') {
  const fields = {};
  const extra = [];
  for (const item of Array.isArray(lead.field_data) ? lead.field_data : []) {
    const name = String(item?.name || '');
    const value = (Array.isArray(item?.values) ? item.values : [item?.values]).filter((v) => v != null && v !== '').join(', ');
    if (!value) continue;
    const key = STANDARD[name.toLowerCase()];
    if (key && !fields[key]) fields[key] = value;
    else extra.push(`${name.replace(/_/g, ' ')}: ${value}`);
  }
  const created = new Date(lead.created_time);
  return {
    sourceRef: String(lead.id || ''),
    receivedAt: Number.isNaN(created.getTime()) ? new Date() : created,
    person: {
      name: fields.name || [fields.first, fields.last].filter(Boolean).join(' '),
      phone: fields.phone || '', email: fields.email || '', company: fields.company || '',
      city: fields.city || '', state: fields.state || '', address: [fields.address, fields.postcode].filter(Boolean).join(' '),
    },
    enquiry: { product: formName, message: extra.join('\n') },
  };
}

module.exports = { getPage, subscribePage, getLead, getFormName, toIntake };
