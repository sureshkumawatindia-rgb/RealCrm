const crypto = require('crypto');
const LeadSourceConnection = require('../models/LeadSourceConnection');
const LeadIntake = require('../models/LeadIntake');
const env = require('../config/env');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { CONNECTION_TYPES } = require('../constants/leadSources');
const { encrypt } = require('../utils/secretBox');
const indiamart = require('./indiamartService');
const { DEFAULT_QUERY_TYPES } = require('../integrations/leadSources/indiamart');
const facebook = require('../integrations/leadSources/facebook');
const leadWebhooks = require('./leadWebhookService');

// Settings → Lead sources: the organization's connections (owners and admins).
const WEBSITE_DEFAULTS = Object.freeze({
  title: 'Send us an enquiry',
  buttonText: 'Send',
  successMessage: 'Thank you! We will contact you shortly.',
  redirectUrl: '',
  allowedOrigins: [],
  askFor: { email: true, company: true, city: true, product: false, message: true },
});

function websiteSettings(settings = {}) {
  return { ...WEBSITE_DEFAULTS, ...settings, askFor: { ...WEBSITE_DEFAULTS.askFor, ...(settings.askFor || {}) } };
}

function serializeConnection(connection) {
  const base = {
    id: connection._id,
    type: connection.type,
    source: CONNECTION_TYPES[connection.type],
    name: connection.name,
    status: connection.status,
    statusMessage: connection.statusMessage,
    settings: connection.type === 'website' ? websiteSettings(connection.settings) : connection.settings || {},
    stats: connection.stats,
    lastPolledAt: connection.lastPolledAt || null,
    lastLeadAt: connection.lastLeadAt || null,
    lastError: connection.lastError,
    lastErrorAt: connection.lastErrorAt || null,
    credentials: { configured: Boolean(connection.credentialsEnc), hint: connection.credentialsHint },
    createdAt: connection.createdAt,
  };
  if (connection.webhookKey) base.pushUrl = `${env.publicUrl}/api/v1/webhooks/leads/${connection.type}/${connection.webhookKey}`;
  if (connection.type === 'indiamart') {
    base.settings = { queryTypes: indiamart.queryTypesOf(connection) };
    base.lastPulledUntil = connection.cursor?.lastEndTime || null;
  }
  // Values to paste into Meta's app / the Google Ads form (owners and admins only see this).
  if (connection.type === 'facebook') {
    base.settings = { pageId: connection.settings?.pageId || '', pageName: connection.settings?.pageName || '' };
    base.verifyToken = leadWebhooks.secretsOf(connection).verifyToken || '';
  }
  if (connection.type === 'googleads') base.googleKey = leadWebhooks.secretsOf(connection).googleKey || '';
  if (connection.type === 'website') {
    const formPath = `/api/v1/public/forms/${connection.publicKey}`;
    base.form = { publicKey: connection.publicKey, submitUrl: `${env.publicUrl}${formPath}`, embedUrl: `${env.publicUrl}${formPath}/embed.js` };
  }
  return base;
}

async function findInOrg(req, id) {
  const connection = await LeadSourceConnection.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!connection) throw httpError(404, 'NOT_FOUND', 'Lead source not found');
  return connection;
}

async function list(req) {
  const connections = await LeadSourceConnection.find({ organizationId: req.tenant.organizationId }).sort({ createdAt: 1 });
  return connections.map(serializeConnection);
}

// Keys, tokens and secrets are kept encrypted together; only a hint (last 4) is shown again,
// except values the organization must paste elsewhere (Meta's verify token, the Google key).
function setSecrets(connection, secrets, hint) {
  const current = leadWebhooks.secretsOf(connection);
  connection.credentialsEnc = encrypt(JSON.stringify({ ...current, ...secrets }));
  if (hint !== undefined) connection.credentialsHint = String(hint).slice(-4);
}
const randomKey = (bytes) => crypto.randomBytes(bytes).toString('base64url');

// Checks a Page token with Facebook and subscribes the Page to lead notifications.
async function connectFacebookPage(pageId, pageAccessToken) {
  const page = await facebook.getPage({ pageId, accessToken: pageAccessToken });
  await facebook.subscribePage({ pageId, accessToken: pageAccessToken });
  return page;
}

async function create(req, body) {
  const pushed = ['indiamart', 'facebook', 'googleads', 'justdial', 'tradeindia'].includes(body.type);
  const connection = new LeadSourceConnection({
    organizationId: req.tenant.organizationId,
    type: body.type,
    name: body.name || `${CONNECTION_TYPES[body.type]} ${body.type === 'website' ? 'form' : ''}`.trim(),
    ...(body.type === 'website' && { publicKey: crypto.randomBytes(12).toString('hex'), settings: websiteSettings(body.settings) }),
    ...(pushed && { webhookKey: crypto.randomBytes(16).toString('hex') }),
    ...(body.type === 'indiamart' && { settings: { queryTypes: body.settings?.queryTypes || [...DEFAULT_QUERY_TYPES] } }),
    createdById: req.user._id,
  });
  if (body.apiKey) setSecrets(connection, { apiKey: body.apiKey }, body.apiKey);
  if (body.type === 'facebook') {
    const page = await connectFacebookPage(body.pageId, body.pageAccessToken);
    connection.settings = { pageId: body.pageId, pageName: page.name, formNames: {} };
    if (!body.name) connection.name = page.name ? `Facebook – ${page.name}` : 'Facebook Lead Ads';
    setSecrets(connection, { pageAccessToken: body.pageAccessToken, appSecret: body.appSecret, verifyToken: randomKey(24) }, body.pageAccessToken);
  }
  if (body.type === 'googleads') setSecrets(connection, { googleKey: randomKey(18) }, '');
  await connection.save();
  await indiamart.schedule(connection);
  await audit(req, { action: 'leadsource.created', entityType: 'LeadSourceConnection', entityId: connection._id, changes: { type: body.type } });
  return serializeConnection(connection);
}

async function update(req, id, body) {
  const connection = await findInOrg(req, id);
  if ('name' in body) connection.name = body.name;
  if ('status' in body) {
    connection.status = body.status;
    if (body.status === 'active') connection.statusMessage = '';
  }
  if (body.settings) {
    connection.settings = connection.type === 'website' ? websiteSettings({ ...connection.settings, ...body.settings }) : { ...connection.settings, ...body.settings };
    connection.markModified('settings');
  }
  if (body.pageAccessToken && connection.type === 'facebook') {
    await connectFacebookPage(connection.settings.pageId, body.pageAccessToken);
    setSecrets(connection, { pageAccessToken: body.pageAccessToken }, body.pageAccessToken);
  }
  if (body.appSecret && connection.type === 'facebook') setSecrets(connection, { appSecret: body.appSecret });
  if (body.apiKey) setSecrets(connection, { apiKey: body.apiKey }, body.apiKey);
  if (body.apiKey || body.pageAccessToken) {
    // A new key or token gets the source going again after it was refused.
    if (connection.status === 'error') connection.status = 'active';
    connection.statusMessage = '';
    connection.lastError = '';
  }
  await connection.save();
  if (connection.status === 'active') await indiamart.schedule(connection);
  else await indiamart.unschedule(connection);
  await audit(req, { action: 'leadsource.updated', entityType: 'LeadSourceConnection', entityId: connection._id, changes: Object.keys(body) });
  return serializeConnection(connection);
}

async function remove(req, id) {
  const connection = await findInOrg(req, id);
  await connection.softDelete();
  await indiamart.unschedule(connection);
  await audit(req, { action: 'leadsource.deleted', entityType: 'LeadSourceConnection', entityId: connection._id });
}

// The latest enquiries of a connection, with what became of them (and the raw payload).
async function intakes(req, id, { limit = 20 } = {}) {
  const connection = await findInOrg(req, id);
  const items = await LeadIntake.find({ organizationId: connection.organizationId, connectionId: connection._id }).sort({ createdAt: -1 }).limit(limit);
  return items.map((item) => ({
    id: item._id,
    source: item.source,
    sourceRef: item.sourceRef,
    outcome: item.outcome,
    reason: item.reason,
    summary: item.summary,
    leadId: item.leadId || null,
    contactId: item.contactId || null,
    receivedAt: item.receivedAt,
    raw: item.raw ?? null,
  }));
}

// Settings → "Pull now" (IndiaMART).
async function pull(req, id) {
  const connection = await findInOrg(req, id);
  if (connection.type !== 'indiamart') throw httpError(400, 'NOT_PULLABLE', 'Only IndiaMART leads are pulled.');
  const result = await indiamart.pullNow(connection);
  return { ...result, connection: serializeConnection(await LeadSourceConnection.findById(connection._id)) };
}

module.exports = { list, create, update, remove, intakes, pull, findInOrg, serializeConnection, websiteSettings };
