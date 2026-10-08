const crypto = require('crypto');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const env = require('../config/env');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const bus = require('../realtime/bus');
const queue = require('../jobs/queue');
const { audit } = require('../utils/audit');
const { encrypt } = require('../utils/secretBox');
const signup = require('../integrations/whatsapp/embeddedSignup');
const { providerFor } = require('../integrations/whatsapp');
const planService = require('./planService');
const accountService = require('./whatsappAccountService');

// "Connect WhatsApp" (D60): an owner or admin opens Meta's Embedded Signup popup on
// connect-whatsapp.html; the page sends us what the popup gave it, and the number is connected
// to the organization — the WhatsApp Business app number itself (coexistence: the app keeps
// working on the phone and its contacts and up to 6 months of chats are imported), or a new
// number. Everything Meta needs to be asked happens here, server to server.
const JOBS = { SYNC: 'whatsapp.coexistence.sync' };

const randomKey = () => crypto.randomBytes(16).toString('hex');

// The sync state for the connect page and Settings, live over Socket.IO ('whatsapp:sync').
function announceSync(account) {
  bus.emit('whatsapp:sync', { organizationId: account.organizationId, accountId: account._id, sync: accountService.serializeSync(account) });
}

// GET /whatsapp/connect — what the connect page needs (appId and configId are not secrets:
// Meta's popup is opened with them in the browser).
async function status(req) {
  const accounts = await WhatsAppAccount.find({ organizationId: req.tenant.organizationId }).sort({ isDefault: -1, createdAt: 1 });
  const available = signup.available();
  return {
    available,
    appId: available ? env.meta.appId : '',
    configId: available ? env.meta.esConfigId : '',
    graphVersion: env.whatsapp.graphVersion,
    connected: accounts.some((account) => account.status === 'connected'),
    accounts: accounts.map(accountService.serializeAccount),
    devTools: env.devTools,
  };
}

// POST /whatsapp/accounts/embedded-signup { code, wabaId, phoneNumberId?, mode }
async function connect(req, { code, wabaId, phoneNumberId, mode }) {
  if (!signup.available()) throw httpError(409, 'CONNECT_NOT_AVAILABLE', 'Connecting WhatsApp is still being set up for this CRM. Please try again later.');
  const { organizationId } = req.tenant;
  const coexistence = mode === 'coexistence';

  const accessToken = await signup.exchangeCode(code);
  const numbers = await signup.phoneNumbersOf({ wabaId, accessToken });
  const number = phoneNumberId ? numbers.find((item) => item.phoneNumberId === phoneNumberId) : numbers[0];
  if (!number) throw httpError(400, 'WHATSAPP_CONNECT_FAILED', 'Meta did not share a phone number with this CRM. Please connect again and choose your number.');

  // A number belongs to one company; connecting this company's own number again reconnects it.
  const holder = await WhatsAppAccount.findOne({ activePhoneNumberId: number.phoneNumberId });
  if (holder && String(holder.organizationId) !== String(organizationId)) {
    throw httpError(409, 'NUMBER_IN_USE', 'This WhatsApp number is already connected to another company in this CRM.');
  }
  let account = holder || await WhatsAppAccount.findOne({ organizationId, phoneNumberId: number.phoneNumberId });
  if (!account) await planService.assertRoom(organizationId, 'whatsappNumbers', { action: 'connect WhatsApp numbers' });

  await signup.subscribeApp({ wabaId, accessToken });
  let pin = '';
  if (!coexistence) {
    // A new number is registered on the Cloud API with a two-step PIN we keep (encrypted).
    pin = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    await signup.registerNumber({ phoneNumberId: number.phoneNumberId, accessToken, pin });
  }

  if (!account) {
    account = new WhatsAppAccount({
      organizationId, provider: 'meta', phoneNumberId: number.phoneNumberId,
      verifyTokenEnc: encrypt(crypto.randomBytes(24).toString('base64url')), webhookKey: randomKey(),
      isDefault: !(await WhatsAppAccount.exists({ organizationId })), createdById: req.user._id,
    });
  }
  Object.assign(account, {
    activePhoneNumberId: number.phoneNumberId, wabaId, displayPhone: number.displayPhone, verifiedName: number.verifiedName,
    qualityRating: number.qualityRating, connectionType: coexistence ? 'coexistence' : 'embedded', connectedAt: new Date(),
    status: 'connected', statusMessage: '', accessTokenEnc: encrypt(accessToken), accessTokenLast4: accessToken.slice(-4),
  });
  if (pin) account.registrationPinEnc = encrypt(pin);
  if (coexistence) account.sync = { status: 'pending', contacts: 0, chats: 0, messages: 0 };
  try {
    const details = await providerFor(account).getPhoneNumber(accountService.credentials(account));
    account.messagingLimit = details.messagingLimit || account.messagingLimit;
  } catch (error) {
    logger.warn(`WhatsApp messaging limit of ${number.phoneNumberId} not read: ${error.message}`);
  }
  try {
    await account.save();
  } catch (error) {
    if (error.code === 11000) throw httpError(409, 'NUMBER_IN_USE', 'This WhatsApp number is already connected to another company in this CRM.');
    throw error;
  }

  if (coexistence) await queue.enqueue(JOBS.SYNC, { accountId: String(account._id) }, { uniqueKey: `whatsapp-sync:${account._id}`, organizationId, maxAttempts: 5 });
  await audit(req, { action: 'whatsapp.account.connected', entityType: 'WhatsAppAccount', entityId: account._id, changes: { connectionType: account.connectionType, phoneNumberId: number.phoneNumberId } });
  return accountService.serializeAccount(account);
}

// POST /whatsapp/accounts/:id/sync — ask Meta again (Meta allows it within 24 hours of connecting).
async function requestSync(req, id) {
  const account = await accountService.findInOrg(req, id);
  if (account.connectionType !== 'coexistence') throw httpError(400, 'VALIDATION_ERROR', 'Only a WhatsApp Business app number brings its chats along.');
  account.sync = { ...(account.sync?.toObject?.() || {}), status: 'pending', error: '' };
  await account.save();
  await queue.enqueue(JOBS.SYNC, { accountId: String(account._id) }, { uniqueKey: `whatsapp-sync:${account._id}`, organizationId: account.organizationId, maxAttempts: 5 });
  announceSync(account);
  return accountService.serializeAccount(account);
}

// The job: contacts first, then the history (Meta's order). Meta then sends them as webhooks.
async function runSync({ accountId }, job) {
  const account = await WhatsAppAccount.findById(accountId);
  if (!account || account.connectionType !== 'coexistence' || account.status !== 'connected') return;
  const credentials = accountService.credentials(account);
  try {
    await signup.startSync({ ...credentials, syncType: 'smb_app_state_sync' });
    await signup.startSync({ ...credentials, syncType: 'history' });
  } catch (error) {
    if (job && job.attempts >= job.maxAttempts) {
      const failed = await WhatsAppAccount.findOneAndUpdate({ _id: account._id }, { $set: { 'sync.status': 'failed', 'sync.error': String(error.message).slice(0, 300) } }, { returnDocument: 'after' });
      announceSync(failed);
    }
    throw error;
  }
  const started = await WhatsAppAccount.findOneAndUpdate(
    { _id: account._id, 'sync.status': { $in: ['pending', 'failed'] } },
    { $set: { 'sync.status': 'importing', 'sync.requestedAt': new Date(), 'sync.error': '' } },
    { returnDocument: 'after' },
  );
  if (started) announceSync(started);
}

function register(jobQueue) {
  jobQueue.define(JOBS.SYNC, runSync, { maxAttempts: 5 });
}

module.exports = { JOBS, status, connect, requestSync, runSync, register, announceSync };
