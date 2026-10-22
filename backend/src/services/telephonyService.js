const crypto = require('crypto');
const TelephonyConnection = require('../models/TelephonyConnection');
const env = require('../config/env');
const httpError = require('../utils/httpError');
const { encrypt, decrypt } = require('../utils/secretBox');
const { audit } = require('../utils/audit');
const { normalizePhone } = require('../utils/phone');
const telephony = require('../integrations/telephony');

// The company's cloud-telephony connection for click-to-call (Phase 6, D85), Settings → Calling
// (owners and admins). One per company; the API key and token are stored encrypted and never
// sent back; the status webhook's address carries the connection's random key.
const webhookUrlOf = (connection) => `${env.publicUrl}/api/v1/webhooks/calls/${connection.webhookKey}`;

function serialize(connection) {
  if (!connection) return { connected: false, providers: ['exotel', ...(telephony.mockAllowed() ? ['mock'] : [])] };
  return {
    connected: true,
    provider: connection.provider,
    accountSid: connection.accountSid,
    subdomain: connection.subdomain,
    callerId: connection.callerId,
    status: connection.status,
    lastError: connection.lastError,
    lastCallAt: connection.lastCallAt || null,
    webhookUrl: webhookUrlOf(connection),
    hasKeys: Boolean(connection.apiKeyEnc && connection.apiTokenEnc),
    providers: ['exotel', ...(telephony.mockAllowed() ? ['mock'] : [])],
  };
}

const get = async (req) => serialize(await TelephonyConnection.findOne({ organizationId: req.tenant.organizationId }));

// What the adapter needs (secrets opened).
function credentialsOf(connection) {
  return {
    accountSid: connection.accountSid,
    subdomain: connection.subdomain,
    callerId: connection.callerId,
    apiKey: connection.apiKeyEnc ? decrypt(connection.apiKeyEnc) : '',
    apiToken: connection.apiTokenEnc ? decrypt(connection.apiTokenEnc) : '',
  };
}

// PUT /telephony — connect, or change the connection (empty key / token keep the saved ones).
async function save(req, body) {
  const provider = telephony.providerFor(body.provider);
  if (!provider) throw httpError(400, 'VALIDATION_ERROR', 'This calling provider is not available.');
  const organizationId = req.tenant.organizationId;
  const existing = await TelephonyConnection.findOne({ organizationId });
  const callerId = body.provider === 'mock' ? body.callerId || '+910000000000' : normalizePhone(body.callerId);
  if (!callerId) throw httpError(400, 'VALIDATION_ERROR', 'Give the number customers will see (your ExoPhone), with its area or mobile code.', [{ field: 'callerId', code: 'INVALID_PHONE', message: 'Not a phone number.' }]);
  const set = {
    provider: body.provider,
    accountSid: body.accountSid || '',
    subdomain: body.subdomain || 'api.exotel.com',
    callerId,
    status: 'active',
    lastError: '',
    ...(body.apiKey && { apiKeyEnc: encrypt(body.apiKey) }),
    ...(body.apiToken && { apiTokenEnc: encrypt(body.apiToken) }),
  };
  if (body.provider === 'exotel' && !(set.apiKeyEnc || existing?.apiKeyEnc)) throw httpError(400, 'VALIDATION_ERROR', 'Give the Exotel API key and token.', [{ field: 'apiKey', code: 'REQUIRED', message: 'Required.' }]);
  if (body.provider === 'exotel' && !(set.apiTokenEnc || existing?.apiTokenEnc)) throw httpError(400, 'VALIDATION_ERROR', 'Give the Exotel API token.', [{ field: 'apiToken', code: 'REQUIRED', message: 'Required.' }]);
  const connection = await TelephonyConnection.findOneAndUpdate(
    { organizationId },
    { $set: set, $setOnInsert: { webhookKey: crypto.randomBytes(16).toString('hex'), createdById: req.user._id } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  await audit(req, { action: existing ? 'telephony.updated' : 'telephony.connected', entityType: 'TelephonyConnection', entityId: connection._id, changes: { provider: set.provider, accountSid: set.accountSid, callerId, newSecrets: Boolean(body.apiKey || body.apiToken) } });
  return serialize(connection);
}

// POST /telephony/test — the provider accepts the keys.
async function test(req) {
  const connection = await TelephonyConnection.findOne({ organizationId: req.tenant.organizationId });
  if (!connection) throw httpError(404, 'NOT_CONNECTED', 'No calling provider is connected.');
  try {
    await telephony.providerFor(connection.provider).test(credentialsOf(connection));
    await TelephonyConnection.updateOne({ _id: connection._id }, { $set: { status: 'active', lastError: '' } });
    return { ok: true };
  } catch (error) {
    await TelephonyConnection.updateOne({ _id: connection._id }, { $set: { status: 'error', lastError: error.message } });
    return { ok: false, error: error.message };
  }
}

async function remove(req) {
  const removed = await TelephonyConnection.findOneAndDelete({ organizationId: req.tenant.organizationId });
  if (removed) await audit(req, { action: 'telephony.disconnected', entityType: 'TelephonyConnection', entityId: removed._id, changes: { provider: removed.provider } });
  return { disconnected: Boolean(removed) };
}

const findByWebhookKey = (key) => (/^[a-f0-9]{32}$/.test(String(key || '')) ? TelephonyConnection.findOne({ webhookKey: key }) : null);

module.exports = { get, save, test, remove, credentialsOf, findByWebhookKey, webhookUrlOf, serialize };
