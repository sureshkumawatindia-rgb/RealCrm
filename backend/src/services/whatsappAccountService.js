const crypto = require('crypto');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const env = require('../config/env');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { encrypt, decrypt } = require('../utils/secretBox');
const { providerFor } = require('../integrations/whatsapp');
const planService = require('./planService');

// Settings → WhatsApp: the organization's connected numbers. Owners and admins only.
const webhookPath = (account) => `/api/v1/webhooks/whatsapp/${account.webhookKey}`;

// The Meta catalog connected to the number (Phase 8C), or null.
function serializeCatalog(account) {
  const c = account.catalog || {};
  if (!c.catalogId) return null;
  return {
    accountId: account._id, catalogId: c.catalogId, name: c.name || '', productCount: c.productCount ?? null, status: c.status || 'connected', statusMessage: c.statusMessage || '',
    checkedAt: c.checkedAt || null, catalogVisible: c.catalogVisible ?? null, cartEnabled: c.cartEnabled ?? null, lastSyncAt: c.lastSyncAt || null,
    lastSync: c.lastSync ? { sent: c.lastSync.sent || 0, removed: c.lastSync.removed || 0, failed: c.lastSync.failed || 0, error: c.lastSync.error || '' } : null,
  };
}

function serializeAccount(account) {
  return {
    id: account._id,
    name: account.name,
    provider: account.provider,
    phoneNumberId: account.phoneNumberId,
    wabaId: account.wabaId,
    displayPhone: account.displayPhone,
    verifiedName: account.verifiedName,
    qualityRating: account.qualityRating,
    messagingLimit: account.messagingLimit || '',
    status: account.status,
    statusMessage: account.statusMessage,
    isDefault: account.isDefault,
    lastWebhookAt: account.lastWebhookAt || null,
    // What to paste into the Meta app (Webhooks → Callback URL / Verify token).
    webhookPath: webhookPath(account),
    webhookUrl: `${env.publicUrl}${webhookPath(account)}`,
    verifyToken: decrypt(account.verifyTokenEnc),
    accessToken: { configured: Boolean(account.accessTokenEnc), last4: account.accessTokenLast4 },
    appSecretConfigured: Boolean(account.appSecretEnc),
    catalog: serializeCatalog(account),
    createdAt: account.createdAt,
  };
}

// Plain values the provider needs (decrypted only here, never returned to the browser).
function credentials(account) {
  return {
    phoneNumberId: account.phoneNumberId,
    accessToken: account.accessTokenEnc ? decrypt(account.accessTokenEnc) : '',
  };
}

function setSecrets(account, { accessToken, appSecret }) {
  if (accessToken) {
    account.accessTokenEnc = encrypt(accessToken);
    account.accessTokenLast4 = accessToken.slice(-4);
  }
  if (appSecret) account.appSecretEnc = encrypt(appSecret);
}

async function findInOrg(req, id) {
  const account = await WhatsAppAccount.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!account) throw httpError(404, 'NOT_FOUND', 'WhatsApp number not found');
  return account;
}

// Asks Meta (or the mock) about the number; the account records the outcome either way.
async function check(account) {
  try {
    const details = await providerFor(account).getPhoneNumber(credentials(account));
    Object.assign(account, details, { status: 'connected', statusMessage: '' });
  } catch (error) {
    account.status = 'error';
    account.statusMessage = String(error.message || 'Could not check the number.').slice(0, 300);
  }
}

async function list(req) {
  const accounts = await WhatsAppAccount.find({ organizationId: req.tenant.organizationId }).sort({ isDefault: -1, createdAt: 1 });
  return accounts.map(serializeAccount);
}

async function create(req, body) {
  const provider = body.provider || 'meta';
  if (provider === 'mock' && !env.devTools) {
    throw httpError(400, 'VALIDATION_ERROR', 'Test numbers are developer test tools (DEV_TOOLS=on, never in production).');
  }
  if (provider === 'meta' && (!body.phoneNumberId || !body.accessToken || !body.appSecret)) {
    throw httpError(400, 'VALIDATION_ERROR', 'Phone number ID, access token and app secret are required.');
  }
  await planService.assertRoom(req.tenant.organizationId, 'whatsappNumbers', { action: 'connect WhatsApp numbers' });
  const phoneNumberId = provider === 'mock' ? body.phoneNumberId || `mock-${crypto.randomBytes(6).toString('hex')}` : body.phoneNumberId;
  if (await WhatsAppAccount.exists({ activePhoneNumberId: phoneNumberId })) {
    throw httpError(409, 'NUMBER_IN_USE', 'This WhatsApp number is already connected (here or in another company).');
  }
  const hasAccounts = await WhatsAppAccount.exists({ organizationId: req.tenant.organizationId });
  const account = new WhatsAppAccount({
    organizationId: req.tenant.organizationId,
    name: body.name || '',
    provider,
    phoneNumberId,
    activePhoneNumberId: phoneNumberId,
    wabaId: body.wabaId || '',
    verifyTokenEnc: encrypt(crypto.randomBytes(24).toString('base64url')),
    webhookKey: crypto.randomBytes(16).toString('hex'),
    isDefault: !hasAccounts,
    createdById: req.user._id,
  });
  setSecrets(account, body);
  await check(account);
  try {
    await account.save();
  } catch (error) {
    if (error.code === 11000) throw httpError(409, 'NUMBER_IN_USE', 'This WhatsApp number is already connected (here or in another company).');
    throw error;
  }
  await audit(req, { action: 'whatsapp.account.created', entityType: 'WhatsAppAccount', entityId: account._id, changes: { provider, phoneNumberId } });
  return serializeAccount(account);
}

async function update(req, id, body) {
  const account = await findInOrg(req, id);
  if ('name' in body) account.name = body.name;
  if ('wabaId' in body) account.wabaId = body.wabaId;
  setSecrets(account, body);
  if (body.isDefault) {
    await WhatsAppAccount.updateMany({ organizationId: account.organizationId, _id: { $ne: account._id } }, { isDefault: false });
    account.isDefault = true;
  }
  if (body.accessToken) await check(account);
  await account.save();
  await audit(req, { action: 'whatsapp.account.updated', entityType: 'WhatsAppAccount', entityId: account._id, changes: Object.keys(body) });
  return serializeAccount(account);
}

async function test(req, id) {
  const account = await findInOrg(req, id);
  await check(account);
  await account.save();
  return serializeAccount(account);
}

// Conversations and messages stay; the number can be connected again later.
async function remove(req, id) {
  const account = await findInOrg(req, id);
  account.activePhoneNumberId = undefined;
  account.isDefault = false;
  await account.softDelete();
  const next = await WhatsAppAccount.findOne({ organizationId: account.organizationId }).sort({ createdAt: 1 });
  if (next && !(await WhatsAppAccount.exists({ organizationId: account.organizationId, isDefault: true }))) {
    next.isDefault = true;
    await next.save();
  }
  await audit(req, { action: 'whatsapp.account.deleted', entityType: 'WhatsAppAccount', entityId: account._id });
}

// For the public webhook: the account behind a callback URL (active accounts only).
async function findByWebhookKey(webhookKey) {
  if (!/^[a-f0-9]{32}$/.test(String(webhookKey || ''))) return null;
  return WhatsAppAccount.findOne({ webhookKey });
}

function verifyTokenOf(account) {
  try {
    return decrypt(account.verifyTokenEnc);
  } catch (error) {
    logger.error(`WhatsApp verify token could not be read: ${error.message}`);
    return null;
  }
}

function appSecretOf(account) {
  return account.appSecretEnc ? decrypt(account.appSecretEnc) : null;
}

// The organization's default number (the simulator and the inbox use it when none is named).
async function defaultAccount(organizationId) {
  return WhatsAppAccount.findOne({ organizationId }).sort({ isDefault: -1, createdAt: 1 });
}

module.exports = {
  list, create, update, test, remove, findInOrg, findByWebhookKey, verifyTokenOf, appSecretOf, credentials,
  defaultAccount, serializeAccount, serializeCatalog,
};
