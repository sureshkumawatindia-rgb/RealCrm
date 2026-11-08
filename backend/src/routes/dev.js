const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const env = require('../config/env');
const Call = require('../models/Call');
const Message = require('../models/Message');
const SocialAccount = require('../models/SocialAccount');
const Conversation = require('../models/Conversation');
const socialMock = require('../integrations/social/mock');
const accountService = require('../services/whatsappAccountService');
const inbound = require('../services/whatsappInboundService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const httpError = require('../utils/httpError');
const { normalizePhone } = require('../utils/phone');
const schemas = require('../validators/whatsapp');
const mock = require('../integrations/whatsapp/mock');
const leadIntake = require('../services/leadIntakeService');
const leadSchemas = require('../validators/leadSources');
const Joi = require('joi');
const google = require('../integrations/google');

// Developer test tools. They do not exist in production, nor in development unless DEV_TOOLS is
// on (404): the real product never shows simulated chats or leads.
const router = express.Router();
router.use((req, res, next) => next(env.devTools ? undefined : httpError(404, 'NOT_FOUND', 'Resource not found')));
router.use(authenticate, requireRole('owner', 'admin'));

// The webhook message object for a simulated photo, document or voice note (test numbers:
// the mock provider hands out a sample file for these media ids).
function simulatedMedia(type, caption) {
  const id = mock.mockMediaId(type);
  const { buffer, mimeType } = mock.sampleFile(type);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('base64');
  if (type === 'image') return { image: { id, mime_type: mimeType, sha256, ...(caption && { caption }) } };
  if (type === 'document') return { document: { id, mime_type: mimeType, sha256, filename: 'Sample document.pdf', ...(caption && { caption }) } };
  return { audio: { id, mime_type: mimeType, sha256, voice: true } };
}

// Pretends a customer sent a WhatsApp message: the same processing as a real webhook, without Meta.
router.post('/simulate/whatsapp-inbound', validate({ body: schemas.simulateInbound }), async (req, res) => {
  const { accountId, from, name, type, text, replyId, items, catalogId, ad, flowToken, answers } = req.body;
  const account = accountId
    ? await accountService.findInOrg(req, accountId)
    : await accountService.defaultAccount(req.tenant.organizationId);
  if (!account) throw httpError(400, 'NO_WHATSAPP_NUMBER', 'Add a WhatsApp number in Settings → WhatsApp first.');
  if (type !== 'text' && account.provider !== 'mock') {
    throw httpError(400, 'VALIDATION_ERROR', 'Photos, documents, voice notes and button taps can only be simulated on a test number.');
  }
  const phone = normalizePhone(from);
  if (!phone) throw httpError(400, 'VALIDATION_ERROR', 'That is not a valid phone number.', [{ field: 'from', code: 'INVALID_PHONE', message: 'Use a number like 98290 12345 or +91 98290 12345.' }]);

  const waId = phone.slice(1);
  const messageId = `wamid.SIM${crypto.randomBytes(12).toString('hex')}`;
  // A tapped bot button or list row looks like WhatsApp's interactive reply.
  // A cart from the WhatsApp catalog looks like Meta's "order" message.
  const order = () => ({
    order: {
      catalog_id: catalogId || account.catalog?.catalogId || 'simulated', ...(text && { text }),
      product_items: items.map((item) => ({ product_retailer_id: item.retailerId, quantity: item.quantity, item_price: item.price, currency: 'INR' })),
    },
  });
  // G6 (D110): a WhatsApp form's answers look like Meta's nfm_reply (an interactive message).
  const form = () => ({ interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: JSON.stringify({ ...(flowToken && { flow_token: flowToken }), ...answers }) } } });
  const content = type === 'text' ? { text: { body: text } }
    : type === 'interactive' ? { interactive: { type: 'button_reply', button_reply: { id: replyId, title: text } } }
      : type === 'order' ? order()
        : type === 'form' ? form()
          : simulatedMedia(type, text);
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: account.wabaId || 'simulated',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: account.displayPhone, phone_number_id: account.phoneNumberId },
          contacts: [{ profile: { name: name || '' }, wa_id: waId }],
          messages: [{
            from: waId, id: messageId, timestamp: String(Math.floor(Date.now() / 1000)), type: type === 'form' ? 'interactive' : type, ...content,
            // D102: a Click-to-WhatsApp ad's referral, in Meta's field names.
            ...(ad && {
              referral: {
                source_type: 'ad', source_id: ad.sourceId || '120200000000000001', source_url: ad.sourceUrl || 'https://fb.me/simulated-ad',
                headline: ad.headline || 'Chat with us', body: ad.body || '', media_type: 'image', image_url: 'https://scontent.example/ad.jpg',
                ...(ad.ctwaClid !== '' && { ctwa_clid: ad.ctwaClid || `Simulated-${crypto.randomBytes(8).toString('hex')}` }),
              },
            }),
          }],
        },
      }],
    }],
  };
  await inbound.processNow(await inbound.ingest(account, payload));
  const message = await Message.findOne({ providerMessageId: messageId, organizationId: account.organizationId });
  if (!message) throw httpError(500, 'SIMULATION_FAILED', 'The simulated message was not stored.');
  res.status(201).json({ success: true, data: { conversationId: message.conversationId, messageId: message._id, contactId: message.contactId } });
});

// G7 (D111): pretends WhatsApp sent a call webhook (test numbers only), processed like a real one:
// a customer calls (with a sample audio offer), our call rings, is picked up (with a sample audio
// answer) or declined, a call ends, or the customer answers our request to call them.
router.post('/simulate/whatsapp-call', validate({ body: schemas.simulateCall }), async (req, res) => {
  const { accountId, event, from, name, callId, status, duration, response, permanent } = req.body;
  const account = accountId
    ? await accountService.findInOrg(req, accountId)
    : await accountService.defaultAccount(req.tenant.organizationId);
  if (!account) throw httpError(400, 'NO_WHATSAPP_NUMBER', 'Add a WhatsApp number in Settings → WhatsApp first.');
  if (account.provider !== 'mock') throw httpError(400, 'VALIDATION_ERROR', 'Calls can only be simulated on a test number.');
  const now = Math.floor(Date.now() / 1000);
  const business = String(account.displayPhone || '').replace(/\D/g, '');
  const value = { messaging_product: 'whatsapp', metadata: { display_phone_number: account.displayPhone, phone_number_id: account.phoneNumberId } };
  let call = null; // the call the event is about
  let newCallId = ''; // a customer's new call: Meta's id for it
  if (event === 'incoming' || event === 'permission') {
    const phone = normalizePhone(from);
    if (!phone) throw httpError(400, 'VALIDATION_ERROR', 'That is not a valid phone number.', [{ field: 'from', code: 'INVALID_PHONE', message: 'Use a number like 98290 12345 or +91 98290 12345.' }]);
    const waId = phone.slice(1);
    value.contacts = [{ profile: { name: name || '' }, wa_id: waId }];
    if (event === 'incoming') {
      newCallId = `wacid.SIM${crypto.randomBytes(12).toString('hex')}`;
      value.calls = [{ id: newCallId, from: waId, to: business, event: 'connect', timestamp: String(now), direction: 'USER_INITIATED', session: { sdp_type: 'offer', sdp: mock.sampleSdp('offer') } }];
    } else {
      value.messages = [{
        from: waId, id: `wamid.SIM${crypto.randomBytes(12).toString('hex')}`, timestamp: String(now), type: 'interactive',
        interactive: { type: 'call_permission_reply', call_permission_reply: { response, is_permanent: permanent, ...(response === 'accept' && !permanent && { expiration_timestamp: now + 7 * 24 * 3600 }), response_source: 'user_action' } },
      }];
    }
  } else {
    const filter = { organizationId: account.organizationId, provider: 'whatsapp', 'whatsapp.accountId': account._id };
    call = callId
      ? await Call.findOne({ ...filter, $or: [{ providerCallId: callId }, ...(mongoose.isValidObjectId(callId) ? [{ _id: callId }] : [])] })
      : await Call.findOne(filter).sort({ _id: -1 }); // the newest made (a webhook's start time has whole seconds)
    if (!call?.providerCallId) throw httpError(404, 'NOT_FOUND', 'There is no WhatsApp call of this number to simulate that for.');
    const customer = String(call.direction === 'in' ? call.fromNumber : call.toNumber).replace(/\D/g, '');
    const [caller, callee] = call.direction === 'in' ? [customer, business] : [business, customer];
    const direction = call.direction === 'in' ? 'USER_INITIATED' : 'BUSINESS_INITIATED';
    const statusOf = (state) => [{ id: call.providerCallId, timestamp: String(now), type: 'call', status: state, recipient_id: customer }];
    if (event === 'ringing') value.statuses = statusOf('RINGING');
    if (event === 'decline') value.statuses = statusOf('REJECTED');
    if (event === 'answer') {
      // The customer picks up our call: WhatsApp's audio answer, then "accepted".
      value.calls = [{ id: call.providerCallId, from: caller, to: callee, event: 'connect', timestamp: String(now), direction, session: { sdp_type: 'answer', sdp: mock.sampleSdp('answer') } }];
      value.statuses = statusOf('ACCEPTED');
    }
    if (event === 'end') {
      const length = duration ?? 0;
      value.calls = [{
        id: call.providerCallId, from: caller, to: callee, event: 'terminate', timestamp: String(now), direction, status,
        ...(length > 0 && { start_time: String(now - length), end_time: String(now), duration: length }),
      }];
    }
  }
  const field = event === 'permission' ? 'messages' : 'calls';
  const payload = { object: 'whatsapp_business_account', entry: [{ id: account.wabaId || 'simulated', changes: [{ field, value }] }] };
  await inbound.processNow(await inbound.ingest(account, payload));
  const latest = call ? await Call.findById(call._id) : newCallId && await Call.findOne({ organizationId: account.organizationId, provider: 'whatsapp', providerCallId: newCallId });
  res.status(201).json({ success: true, data: { callId: event === 'permission' ? null : latest?._id || null, status: event === 'permission' ? null : latest?.status || null } });
});

// G8 (D112): pretends Meta sent an Instagram or Messenger webhook to a test Page, processed like a
// real one: a customer's message (text, or a photo), a message the business sent from Meta's own
// apps (echo), or the customer reading our messages (read).
const socialSimulation = Joi.object({
  accountId: Joi.string().hex().length(24),
  channel: Joi.string().valid('instagram', 'messenger').default('instagram'),
  from: Joi.string().trim().pattern(/^[A-Za-z0-9_-]{3,60}$/), // the customer's id (default: a new one)
  name: Joi.string().trim().max(100).allow(''),
  username: Joi.string().trim().max(60).allow(''),
  event: Joi.string().valid('message', 'echo', 'read').default('message'),
  type: Joi.string().valid('text', 'image').default('text'),
  text: Joi.string().trim().max(2000).allow(''),
});
router.post('/simulate/social-inbound', validate({ body: socialSimulation }), async (req, res) => {
  const { accountId, channel, name, username, event, type, text } = req.valid.body;
  const account = await SocialAccount.findOne({ organizationId: req.tenant.organizationId, ...(accountId ? { _id: accountId } : { channel }), activeExternalId: { $type: 'string' } }).sort({ createdAt: -1 });
  if (!account) throw httpError(400, 'NO_SOCIAL_ACCOUNT', 'Add a test Page in Settings → WhatsApp → Instagram and Messenger first.');
  if (account.provider !== 'mock') throw httpError(400, 'VALIDATION_ERROR', 'Instagram and Messenger can only be simulated on a test Page.');
  const from = req.valid.body.from || `${Date.now()}${crypto.randomInt(100, 999)}`;
  if (name || username) socialMock.setProfile(from, { name, username });
  const now = Date.now();
  const mid = `m_SIM${crypto.randomBytes(12).toString('hex')}`;
  // Instagram's "seen" names the last message read: ours, the newest in the chat.
  let seenMid = '';
  if (event === 'read' && channel === 'instagram') {
    const chat = await Conversation.findOne({ organizationId: account.organizationId, socialAccountId: account._id, socialUserId: from });
    seenMid = chat ? (await Message.findOne({ conversationId: chat._id, direction: 'out' }).sort({ createdAt: -1 }))?.providerMessageId || '' : '';
  }
  const content = type === 'image'
    ? { attachments: [{ type: 'image', payload: { url: `https://mock.invalid/media/${mock.mockMediaId('image')}` } }], ...(text && { text }) }
    : { text: text || 'Hello' };
  const messaging = {
    message: { sender: { id: from }, recipient: { id: account.externalId }, timestamp: now, message: { mid, ...content } },
    echo: { sender: { id: account.externalId }, recipient: { id: from }, timestamp: now, message: { mid, is_echo: true, ...content } },
    read: { sender: { id: from }, recipient: { id: account.externalId }, timestamp: now, read: channel === 'instagram' ? { mid: seenMid } : { watermark: now } },
  }[event];
  const payload = { object: channel === 'instagram' ? 'instagram' : 'page', entry: [{ id: account.externalId, time: now, messaging: [messaging] }] };
  await inbound.processNow(await inbound.ingestApp(payload));
  const message = event === 'read' ? null : await Message.findOne({ providerMessageId: mid, organizationId: account.organizationId });
  res.status(201).json({ success: true, data: { from, messageId: message?._id || null, conversationId: message?.conversationId || null } });
});

// Pretends a lead arrived from a source (IndiaMART by default): the same intake as a real one.
router.post('/simulate/lead', validate({ body: leadSchemas.simulateLead }), async (req, res) => {
  const { source, sourceRef, name, phone, email, company, city, state, product, quantity, message } = req.body;
  const result = await leadIntake.intake({
    organizationId: req.tenant.organizationId,
    source,
    sourceRef: sourceRef || `sim:${crypto.randomBytes(8).toString('hex')}`,
    person: { name, phone, email, company, city, state },
    enquiry: { product, quantity, message },
    raw: { simulated: true, ...req.body },
  });
  if (result.outcome === 'rejected') {
    return res.status(400).json({ success: false, code: 'LEAD_REJECTED', message: 'The lead needs a valid mobile number or email.', data: result });
  }
  return res.status(201).json({ success: true, data: result });
});

// Puts an email in the signed-in person's stand-in Google mailbox (D90), as if it arrived or was
// sent from Gmail; the next sync picks it up. Only while Google runs as the stand-in.
const mockMail = Joi.object({
  from: Joi.string().trim().max(200).required(),
  to: Joi.string().trim().max(500).required(),
  subject: Joi.string().trim().max(300).allow('').default(''),
  snippet: Joi.string().trim().max(500).allow('').default(''),
  threadId: Joi.string().trim().pattern(/^[A-Za-z0-9_-]{1,60}$/),
});
// A deliberate server error (F3), to check that error reports and their alerts arrive.
router.post('/test-error', () => {
  throw new Error('Test error from the developer tools (F3)');
});

// D120: a weekly backup copy now, so the platform admin page's restore drill has one to restore
// (the browser tests: e2e/privacy.spec.js, with a stand-in R2).
router.post('/backup-now', async (req, res) => {
  const backups = require('../services/backupService'); // eslint-disable-line global-require
  if (!backups.configured()) throw httpError(409, 'BACKUPS_NOT_SET_UP', 'Backups are not set up here.');
  res.status(201).json({ success: true, data: await backups.run() });
});

router.post('/simulate/gmail', validate({ body: mockMail }), async (req, res) => {
  if (google.mode() !== 'mock') throw httpError(409, 'GOOGLE_NOT_MOCK', 'Google is not the stand-in here.');
  const id = google.mock.addMessage(String(req.user.email).toLowerCase(), req.body);
  res.status(201).json({ success: true, data: { id } });
});

module.exports = router;
