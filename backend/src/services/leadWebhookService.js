const crypto = require('crypto');
const LeadSourceConnection = require('../models/LeadSourceConnection');
const LeadIntake = require('../models/LeadIntake');
const logger = require('../config/logger');
const { decrypt } = require('../utils/secretBox');
const facebook = require('../integrations/leadSources/facebook');
const googleAds = require('../integrations/leadSources/googleAds');
const genericPush = require('../integrations/leadSources/genericPush');
const { intake } = require('./leadIntakeService');

// Leads pushed to us by Facebook Lead Ads, Google Ads lead forms, JustDial and TradeIndia. Each
// connection has its own random URL (/api/v1/webhooks/leads/<type>/<key>).
const FACEBOOK_FETCH = 'leadsource.facebook.fetch';

const sameText = (a, b) => {
  const hash = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && crypto.timingSafeEqual(hash(a), hash(b));
};
const secretsOf = (connection) => {
  if (!connection?.credentialsEnc) return {};
  try {
    return JSON.parse(decrypt(connection.credentialsEnc));
  } catch {
    return {};
  }
};

async function findConnection(type, webhookKey) {
  if (!/^[a-f0-9]{32}$/.test(String(webhookKey || ''))) return null;
  return LeadSourceConnection.findOne({ webhookKey, type });
}

// --- Facebook Lead Ads ----------------------------------------------------------
// Meta's handshake when the callback URL is saved in the app.
async function facebookVerify(webhookKey, query) {
  const connection = await findConnection('facebook', webhookKey);
  const challenge = query['hub.challenge'];
  if (!connection || query['hub.mode'] !== 'subscribe' || !sameText(query['hub.verify_token'], secretsOf(connection).verifyToken) || typeof challenge !== 'string') {
    return { status: 403 };
  }
  return { status: 200, body: challenge.slice(0, 200) };
}

function facebookSignatureOk(connection, rawBody, header) {
  const secret = secretsOf(connection).appSecret;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(String(header || ''));
  if (!secret || !match || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(match[1], 'hex'));
}

// The webhook only names new leads: each one is fetched by a job (retried if Facebook is slow).
async function facebookReceive(webhookKey, rawBody, signature, queue) {
  const connection = await findConnection('facebook', webhookKey);
  if (!connection) return { status: 404 };
  if (!facebookSignatureOk(connection, rawBody, signature)) return { status: 401 };
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400 };
  }
  if (connection.status === 'paused') return { status: 200 };
  const pageId = String(connection.settings?.pageId || '');
  const leadIds = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value || {};
      if (change?.field !== 'leadgen' || !value.leadgen_id) continue;
      if (pageId && value.page_id != null && String(value.page_id) !== pageId) continue;
      leadIds.push(String(value.leadgen_id));
    }
  }
  for (const leadgenId of leadIds) {
    await queue.enqueue(FACEBOOK_FETCH, { connectionId: String(connection._id), leadgenId }, { uniqueKey: `facebook:${leadgenId}`, organizationId: connection.organizationId });
  }
  return { status: 200, queued: leadIds.length };
}

async function facebookFetch({ connectionId, leadgenId }) {
  const connection = await LeadSourceConnection.findById(connectionId);
  if (!connection || connection.type !== 'facebook') return;
  if (await LeadIntake.exists({ organizationId: connection.organizationId, source: 'Facebook', sourceRef: leadgenId, outcome: { $ne: 'failed' } })) return;
  const { pageAccessToken } = secretsOf(connection);
  let lead;
  try {
    lead = await facebook.getLead({ accessToken: pageAccessToken }, leadgenId);
  } catch (error) {
    await LeadSourceConnection.updateOne({ _id: connection._id }, { $set: { lastError: `Facebook: ${error.message}`, lastErrorAt: new Date() } });
    if (error.statusCode === 400) {
      // A token or permission problem: retrying will not help until the token is replaced.
      await LeadSourceConnection.updateOne({ _id: connection._id }, { $set: { status: 'error', statusMessage: `Facebook refused to give the lead: ${error.message} Paste a new Page access token.` } });
      return;
    }
    throw error;
  }
  // The form's name tells the team which ad or offer the lead came from.
  const forms = connection.settings?.formNames || {};
  let formName = lead.form_id ? forms[lead.form_id] : '';
  if (lead.form_id && formName === undefined) {
    formName = await facebook.getFormName({ accessToken: pageAccessToken }, lead.form_id).catch(() => '');
    await LeadSourceConnection.updateOne({ _id: connection._id }, { $set: { [`settings.formNames.${lead.form_id}`]: formName } });
  }
  const mapped = facebook.toIntake(lead, formName || '');
  await intake({
    organizationId: connection.organizationId, source: 'Facebook', sourceRef: mapped.sourceRef || leadgenId, connectionId: connection._id,
    person: mapped.person, enquiry: mapped.enquiry, raw: lead, receivedAt: mapped.receivedAt,
  });
  if (connection.lastError) await LeadSourceConnection.updateOne({ _id: connection._id }, { $set: { lastError: '' } });
}

// --- Google Ads lead forms ------------------------------------------------------------
async function googleAdsReceive(webhookKey, payload) {
  const connection = await findConnection('googleads', webhookKey);
  if (!connection) return { status: 404, body: { error: 'Unknown webhook address' } };
  if (!payload || typeof payload !== 'object') return { status: 400, body: { error: 'Expected JSON' } };
  if (!sameText(payload.google_key, secretsOf(connection).googleKey)) return { status: 400, body: { error: 'The key does not match the one in the CRM' } };
  if (connection.status === 'paused') return { status: 200, body: {} };
  const mapped = googleAds.toIntake(payload);
  if (!mapped.sourceRef) return { status: 400, body: { error: 'lead_id is missing' } };
  if (mapped.isTest) {
    // Google's "Send test data": proves the connection works, but is not a real customer.
    await LeadIntake.updateOne(
      { organizationId: connection.organizationId, source: 'Google Ads', sourceRef: `test:${mapped.sourceRef}` },
      { $setOnInsert: { connectionId: connection._id, outcome: 'rejected', reason: 'not added to Leads', summary: 'Google Ads test data', raw: payload, receivedAt: new Date(), processedAt: new Date() } },
      { upsert: true },
    );
    return { status: 200, body: {} };
  }
  await intake({
    organizationId: connection.organizationId, source: 'Google Ads', sourceRef: mapped.sourceRef, connectionId: connection._id,
    person: mapped.person, enquiry: mapped.enquiry, raw: payload,
  });
  return { status: 200, body: {} };
}

// --- JustDial / TradeIndia (no public format) ------------------------------------------
const GENERIC_SOURCES = { justdial: 'JustDial', tradeindia: 'TradeIndia' };

async function genericReceive(type, webhookKey, payload) {
  const connection = await findConnection(type, webhookKey);
  if (!connection) return { status: 404 };
  if (connection.status === 'paused') return { status: 200 };
  const leads = genericPush.leadsIn(payload);
  for (const lead of leads.slice(0, 100)) {
    const mapped = genericPush.toIntake(lead);
    try {
      await intake({
        organizationId: connection.organizationId, source: GENERIC_SOURCES[type], sourceRef: mapped.sourceRef, connectionId: connection._id,
        person: mapped.person, enquiry: mapped.enquiry, raw: lead,
      });
    } catch (error) {
      logger.error(`${GENERIC_SOURCES[type]} lead for ${connection._id} failed: ${error.message}`);
      return { status: 500 };
    }
  }
  return { status: 200 };
}

function register(queue) {
  queue.define(FACEBOOK_FETCH, facebookFetch, { maxAttempts: 6 });
}

module.exports = {
  FACEBOOK_FETCH, GENERIC_SOURCES, facebookVerify, facebookReceive, facebookFetch, googleAdsReceive, genericReceive, register, secretsOf,
};
