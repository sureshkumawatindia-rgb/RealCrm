const SocialAccount = require('../models/SocialAccount');
const env = require('../config/env');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { encrypt, decrypt } = require('../utils/secretBox');
const { providerFor, meta, mock } = require('../integrations/social');
const { SOCIAL_SCOPES } = require('../constants/social');

// Instagram and Messenger accounts (G8, D112), in Settings → WhatsApp → "Instagram and Messenger"
// (owners and admins). Facebook Login for Business (the platform's Meta app, META_SOCIAL_CONFIG_ID):
// every Page the person allows becomes a Messenger account, and the Instagram professional account
// linked to it an Instagram account; the Page is subscribed to the app's webhook. Disconnecting
// keeps the account (old chats still name it) without its token. A test Page (developer tools)
// works without Meta.

function serialize(account) {
  return {
    id: account._id,
    channel: account.channel,
    provider: account.provider,
    name: account.name,
    username: account.username,
    externalId: account.externalId,
    pageId: account.pageId,
    status: account.status,
    statusMessage: account.statusMessage,
    connectedAt: account.connectedAt || null,
    lastWebhookAt: account.lastWebhookAt || null,
    accessToken: { configured: Boolean(account.accessTokenEnc), last4: account.accessTokenLast4 || '' },
  };
}

// What the provider needs (decrypted only here, never sent to the browser).
function credentials(account) {
  return { pageId: account.pageId, accessToken: account.accessTokenEnc ? decrypt(account.accessTokenEnc) : '' };
}

const isConnected = (account) => Boolean(account?.activeExternalId) && account.status !== 'disconnected';

// GET /social — the accounts, and what the connect button needs (the app id and the configuration
// id are not secrets).
async function list(req) {
  const accounts = await SocialAccount.find({ organizationId: req.tenant.organizationId }).sort({ createdAt: 1 });
  const available = meta.available();
  return {
    accounts: accounts.map(serialize),
    connect: { available, appId: available ? env.meta.appId : '', configId: available ? env.meta.socialConfigId : '', graphVersion: env.whatsapp.graphVersion, scopes: SOCIAL_SCOPES },
    devTools: Boolean(env.devTools),
  };
}

async function findInOrg(req, id) {
  const account = await SocialAccount.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!account) throw httpError(404, 'NOT_FOUND', 'Account not found');
  return account;
}

// A Page's Messenger and its Instagram account, for this company (connected again: the same
// accounts, with the new token). problem: the Page could not be subscribed to the webhook.
async function savePage(req, provider, page, problem = '') {
  const organizationId = req.tenant.organizationId;
  const items = [{ channel: 'messenger', externalId: page.id, name: page.name, username: '' }];
  if (page.instagram) items.push({ channel: 'instagram', externalId: page.instagram.id, name: page.instagram.name || page.instagram.username, username: page.instagram.username });
  const saved = [];
  for (const item of items) {
    const elsewhere = await SocialAccount.exists({ channel: item.channel, activeExternalId: item.externalId, organizationId: { $ne: organizationId } });
    if (elsewhere) {
      throw httpError(409, 'SOCIAL_TAKEN', `${item.name || item.externalId} is connected to another company in this CRM. Disconnect it there first.`);
    }
    const account = await SocialAccount.findOne({ organizationId, channel: item.channel, externalId: item.externalId })
      || new SocialAccount({ organizationId, channel: item.channel, externalId: item.externalId, createdById: req.user._id });
    account.set({
      provider, pageId: page.id, name: item.name, username: item.username, activeExternalId: item.externalId,
      status: problem ? 'error' : 'connected', statusMessage: problem, connectedAt: new Date(),
      accessTokenEnc: encrypt(page.accessToken), accessTokenLast4: page.accessToken.slice(-4),
    });
    await account.save();
    saved.push(account);
  }
  return saved;
}

// POST /social/connect { code } — after Meta's popup.
async function connect(req, { code }) {
  if (!meta.available()) throw httpError(409, 'SOCIAL_NOT_SET_UP', 'Instagram and Messenger are not set up on this server yet (the platform\'s Meta app).');
  if (env.isStaging) throw httpError(400, 'STAGING_TEST_PAGES_ONLY', 'Staging uses test Pages only, so no real customer gets a message from it.');
  const userToken = await meta.exchangeCode(code);
  const pages = await meta.pages(userToken);
  if (!pages.length) throw httpError(400, 'NO_PAGES', 'No Facebook Page was shared. Connect again and choose the Pages (and their Instagram accounts) to connect.');
  const saved = [];
  for (const page of pages) {
    let problem = '';
    try {
      await meta.subscribePage({ pageId: page.id, accessToken: page.accessToken });
    } catch (error) {
      problem = `Meta did not send this Page's messages to the CRM: ${error.message}`;
    }
    saved.push(...await savePage(req, 'meta', page, problem));
  }
  await audit(req, { action: 'social.connected', entityType: 'SocialAccount', entityId: saved[0]?._id, changes: { accounts: saved.map((a) => `${a.channel}:${a.externalId}`) } });
  return list(req);
}

// POST /social/test — a test Page with an Instagram account (developer tools only).
async function connectTest(req) {
  if (!env.devTools) throw httpError(400, 'VALIDATION_ERROR', 'Test Pages are developer test tools (DEV_TOOLS=on, never in production).');
  const [page] = await mock.pages();
  const saved = await savePage(req, 'mock', page);
  await audit(req, { action: 'social.connected', entityType: 'SocialAccount', entityId: saved[0]._id, changes: { test: true } });
  return list(req);
}

// DELETE /social/accounts/:id — stops it (the Page stays subscribed while its other account is
// connected). The chats and messages stay.
async function disconnect(req, id) {
  const account = await findInOrg(req, id);
  const sibling = await SocialAccount.exists({ _id: { $ne: account._id }, organizationId: account.organizationId, pageId: account.pageId, activeExternalId: { $type: 'string' } });
  if (!sibling && isConnected(account)) {
    await providerFor(account).unsubscribePage(credentials(account)).catch((error) => logger.warn(`Unsubscribing Page ${account.pageId} failed: ${error.message}`));
  }
  account.status = 'disconnected';
  account.statusMessage = '';
  account.activeExternalId = undefined;
  account.accessTokenEnc = undefined;
  account.accessTokenLast4 = '';
  await account.save();
  await audit(req, { action: 'social.disconnected', entityType: 'SocialAccount', entityId: account._id, changes: { channel: account.channel } });
  return serialize(account);
}

module.exports = { list, connect, connectTest, disconnect, serialize, credentials, isConnected, findInOrg };
