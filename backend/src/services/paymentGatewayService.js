const crypto = require('crypto');
const MessageTemplate = require('../models/MessageTemplate');
const Organization = require('../models/Organization');
const PaymentConnection = require('../models/PaymentConnection');
const env = require('../config/env');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { encrypt, decrypt } = require('../utils/secretBox');
const { gatewayFor } = require('../integrations/payments');
const templateService = require('./templateService');
const { PAYMENT_PROVIDERS, DEFAULT_EXPIRY_DAYS } = require('../constants/payments');

// Settings → Payments (owners and admins): the organization's payment gateways (Razorpay,
// Cashfree, or the test gateway in development) and how payment links behave. Key secrets and
// webhook secrets are encrypted and never sent back; the webhook address is shown to paste
// into the gateway's dashboard (one address per connection, D39).
const webhookPath = (connection) => `/api/v1/webhooks/payments/${connection.provider}/${connection.webhookKey}`;

function serializeConnection(connection) {
  return {
    id: connection._id,
    provider: connection.provider,
    providerName: PAYMENT_PROVIDERS[connection.provider],
    name: connection.name || PAYMENT_PROVIDERS[connection.provider],
    mode: connection.mode,
    keyId: connection.keyId,
    keySecret: { configured: Boolean(connection.keySecretEnc), last4: connection.keySecretLast4 },
    webhookSecretConfigured: Boolean(connection.webhookSecretEnc),
    webhookUrl: connection.provider === 'mock' ? '' : `${env.publicUrl}${webhookPath(connection)}`,
    webhookPath: webhookPath(connection),
    status: connection.status,
    statusMessage: connection.statusMessage,
    isDefault: connection.isDefault,
    lastCheckedAt: connection.lastCheckedAt || null,
    lastWebhookAt: connection.lastWebhookAt || null,
    createdAt: connection.createdAt,
  };
}

const read = (value) => (value ? decrypt(value) : '');
// What the gateway client needs (decrypted only here, never returned to the browser).
const credentialsOf = (connection) => ({ keyId: connection.keyId, keySecret: read(connection.keySecretEnc), mode: connection.mode });
const secretsOf = (connection) => ({ keySecret: read(connection.keySecretEnc), webhookSecret: read(connection.webhookSecretEnc) });

function setSecrets(connection, { keySecret, webhookSecret }) {
  if (keySecret) {
    connection.keySecretEnc = encrypt(keySecret);
    connection.keySecretLast4 = keySecret.slice(-4);
  }
  if (webhookSecret) connection.webhookSecretEnc = encrypt(webhookSecret);
}

async function findInOrg(req, id) {
  const connection = await PaymentConnection.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!connection) throw httpError(404, 'NOT_FOUND', 'Payment gateway not found');
  return connection;
}

// Asks the gateway whether the keys work. Wrong keys are refused before anything is saved;
// a gateway that cannot be reached leaves the connection in "error" to check again later.
async function check(connection) {
  connection.lastCheckedAt = new Date();
  try {
    const { mode } = await gatewayFor(connection.provider).checkKeys(credentialsOf(connection));
    Object.assign(connection, { mode, status: 'connected', statusMessage: '' });
  } catch (error) {
    if (error.code === 'PAYMENT_KEYS_REFUSED') throw httpError(400, 'PAYMENT_KEYS_REFUSED', error.message, [{ field: 'keySecret', code: 'KEYS_REFUSED', message: 'Copy the key id and secret again from the gateway\'s dashboard.' }]);
    connection.status = 'error';
    connection.statusMessage = String(error.message || 'Could not check the keys.').slice(0, 300);
  }
}

async function list(req) {
  const connections = await PaymentConnection.find({ organizationId: req.tenant.organizationId }).sort({ isDefault: -1, createdAt: 1 });
  return connections.map(serializeConnection);
}

async function create(req, body) {
  const { provider } = body;
  if (provider === 'mock' && env.isProduction) throw httpError(400, 'VALIDATION_ERROR', 'The test gateway is only available in development.');
  if (await PaymentConnection.exists({ organizationId: req.tenant.organizationId, provider })) {
    throw httpError(409, 'GATEWAY_EXISTS', `${PAYMENT_PROVIDERS[provider]} is already connected. Change its keys instead.`);
  }
  const hasAny = await PaymentConnection.exists({ organizationId: req.tenant.organizationId });
  const connection = new PaymentConnection({
    organizationId: req.tenant.organizationId,
    provider,
    name: body.name || '',
    mode: provider === 'cashfree' ? body.mode || 'test' : gatewayFor(provider).modeOf(body.keyId),
    keyId: provider === 'mock' ? '' : body.keyId,
    webhookKey: crypto.randomBytes(16).toString('hex'),
    isDefault: !hasAny,
    createdById: req.user._id,
  });
  setSecrets(connection, body);
  await check(connection);
  await connection.save();
  await audit(req, { action: 'payment.gateway.created', entityType: 'PaymentConnection', entityId: connection._id, changes: { provider, mode: connection.mode } });
  return serializeConnection(connection);
}

async function update(req, id, body) {
  const connection = await findInOrg(req, id);
  if ('name' in body) connection.name = body.name;
  if (body.keyId && connection.provider !== 'mock') {
    connection.keyId = body.keyId;
    if (connection.provider === 'razorpay') connection.mode = gatewayFor('razorpay').modeOf(body.keyId);
  }
  if (body.mode && connection.provider === 'cashfree') connection.mode = body.mode;
  setSecrets(connection, body);
  if (body.isDefault) {
    await PaymentConnection.updateMany({ organizationId: connection.organizationId, _id: { $ne: connection._id } }, { isDefault: false });
    connection.isDefault = true;
  }
  if (body.keyId || body.keySecret || body.mode) await check(connection);
  await connection.save();
  await audit(req, { action: 'payment.gateway.updated', entityType: 'PaymentConnection', entityId: connection._id, changes: Object.keys(body) });
  return serializeConnection(connection);
}

async function test(req, id) {
  const connection = await findInOrg(req, id);
  await check(connection);
  await connection.save();
  return serializeConnection(connection);
}

// Links made through it stay in the CRM, but their webhooks and status checks stop.
async function remove(req, id) {
  const connection = await findInOrg(req, id);
  connection.isDefault = false;
  await connection.softDelete();
  const next = await PaymentConnection.findOne({ organizationId: connection.organizationId }).sort({ createdAt: 1 });
  if (next) await PaymentConnection.updateOne({ _id: next._id }, { isDefault: true });
  await audit(req, { action: 'payment.gateway.deleted', entityType: 'PaymentConnection', entityId: connection._id });
}

// The gateway a new link goes through: the one asked for, else the default one.
async function connectionFor(organizationId, connectionId) {
  const connection = connectionId
    ? await PaymentConnection.findOne({ _id: connectionId, organizationId })
    : await PaymentConnection.findOne({ organizationId }).sort({ isDefault: -1, createdAt: 1 });
  if (!connection) {
    throw httpError(409, 'NO_PAYMENT_GATEWAY', connectionId ? 'Payment gateway not found.' : 'Connect Razorpay or Cashfree in Settings → Payments first.');
  }
  return connection;
}

// For the public webhook: the connection behind an address.
async function findByWebhookKey(provider, webhookKey) {
  if (!/^[a-f0-9]{32}$/.test(String(webhookKey || ''))) return null;
  return PaymentConnection.findOne({ provider, webhookKey });
}

// --- payment settings -----------------------------------------------------------------
function settingsOf(organization) {
  const payments = organization?.payments || {};
  return {
    expiryDays: payments.expiryDays || DEFAULT_EXPIRY_DAYS,
    sendReceipt: payments.sendReceipt !== false,
    linkTemplateId: payments.linkTemplateId || null,
    receiptTemplateId: payments.receiptTemplateId || null,
  };
}

async function getSettings(req) {
  return settingsOf(await Organization.findById(req.tenant.organizationId));
}

async function putSettings(req, body) {
  for (const field of ['linkTemplateId', 'receiptTemplateId']) {
    if (!body[field]) continue;
    const template = await MessageTemplate.findOne({ _id: body[field], organizationId: req.tenant.organizationId });
    if (!template || template.status !== 'APPROVED') {
      throw httpError(400, 'VALIDATION_ERROR', 'Pick an approved WhatsApp template.', [{ field, code: 'TEMPLATE_NOT_APPROVED', message: 'Pick an approved WhatsApp template.' }]);
    }
    const shape = templateService.shapeOf(template);
    if (!shape.sendable) throw httpError(400, 'VALIDATION_ERROR', `"${template.name}" cannot be sent here: ${shape.notSendableReason}`, [{ field, code: 'TEMPLATE_NOT_SENDABLE', message: shape.notSendableReason }]);
  }
  const set = Object.fromEntries(Object.entries(body).map(([key, value]) => [`payments.${key}`, value || (key.endsWith('TemplateId') ? null : value)]));
  const organization = await Organization.findByIdAndUpdate(req.tenant.organizationId, { $set: set }, { returnDocument: 'after' });
  await audit(req, { action: 'payment.settings.updated', entityType: 'Organization', entityId: organization._id, changes: Object.keys(body) });
  return settingsOf(organization);
}

module.exports = {
  list, create, update, test, remove, findInOrg, connectionFor, findByWebhookKey, credentialsOf, secretsOf, serializeConnection,
  getSettings, putSettings, settingsOf,
};
