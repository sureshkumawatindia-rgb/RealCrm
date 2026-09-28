jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const InboundEvent = require('../models/InboundEvent');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const inbound = require('../services/whatsappInboundService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const APP_SECRET = 'test-app-secret-0123456789';
const TOKEN = 'EAAG-test-access-token-9876';

// Stands in for graph.facebook.com.
function fakeGraph(handler) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
    const { status = 200, body = {} } = await handler(String(url), options);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}
const phoneOk = () => ({ body: { display_phone_number: '+91 98290 00000', verified_name: 'Yellow Traders', quality_rating: 'GREEN', id: '1234567890' } });

const sign = (raw, secret = APP_SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
const postWebhook = (account, payload, signature) => {
  const raw = JSON.stringify(payload);
  return api().post(account.webhookPath).set('Content-Type', 'application/json').set('X-Hub-Signature-256', signature || sign(raw)).send(raw);
};
const webhook = (phoneNumberId, { messages = [], statuses = [], contacts = [] }) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '919829000000', phone_number_id: phoneNumberId }, contacts, messages, statuses } }] }],
});
const textMessage = (id, from, body, timestamp = '1790000000') => ({ from, id, timestamp, type: 'text', text: { body } });

describe('WhatsApp numbers (Settings → WhatsApp)', () => {
  let owner;
  beforeAll(async () => { owner = await login('wa-owner@example.com'); });
  afterEach(() => jest.restoreAllMocks());

  it('connects a Meta number: checks it with Meta and never returns the secrets', async () => {
    const graph = fakeGraph(phoneOk);
    const res = await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token))
      .send({ name: 'Sales line', phoneNumberId: '1234567890', wabaId: '5550001', accessToken: TOKEN, appSecret: APP_SECRET });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      provider: 'meta', status: 'connected', displayPhone: '+91 98290 00000', verifiedName: 'Yellow Traders', isDefault: true,
      accessToken: { configured: true, last4: '9876' }, appSecretConfigured: true,
    });
    expect(res.body.data.webhookPath).toMatch(/^\/api\/v1\/webhooks\/whatsapp\/[a-f0-9]{32}$/);
    expect(res.body.data.verifyToken.length).toBeGreaterThan(20);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(JSON.stringify(res.body)).not.toContain(APP_SECRET);

    const [url, options] = graph.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v26.0/1234567890?fields=display_phone_number,verified_name,quality_rating');
    expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const stored = await WhatsAppAccount.findById(res.body.data.id);
    expect(stored.accessTokenEnc).not.toContain(TOKEN);
  });

  it('records a wrong token as an error, refuses a number used elsewhere, and is for owners/admins only', async () => {
    fakeGraph(() => ({ status: 400, body: { error: { message: 'Invalid OAuth access token.', code: 190 } } }));
    const bad = await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token))
      .send({ phoneNumberId: '2223334445', accessToken: 'wrong-token-xx', appSecret: APP_SECRET });
    expect(bad.body.data).toMatchObject({ status: 'error', statusMessage: 'Invalid OAuth access token.' });

    const other = await login('wa-other@example.com');
    const taken = await api().post('/api/v1/whatsapp/accounts').set(bearer(other.token))
      .send({ phoneNumberId: '1234567890', accessToken: TOKEN, appSecret: APP_SECRET });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('NUMBER_IN_USE');

    expect((await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ phoneNumberId: '12', accessToken: TOKEN, appSecret: APP_SECRET })).status).toBe(400);
    const agent = await inviteAndJoin(owner.token, 'wa-agent@example.com', { role: 'agent', modules: ['inbox'] });
    expect((await api().get('/api/v1/whatsapp/accounts').set(bearer(agent.token))).status).toBe(403);
  });
});

describe('WhatsApp webhook', () => {
  let owner;
  let account;
  beforeAll(async () => {
    owner = await login('wh-owner@example.com');
    fakeGraph(phoneOk);
    account = (await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token))
      .send({ phoneNumberId: '9990001112', accessToken: TOKEN, appSecret: APP_SECRET })).body.data;
    jest.restoreAllMocks();
  });

  it("answers Meta's handshake only with the right verify token", async () => {
    const ok = await api().get(`${account.webhookPath}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(account.verifyToken)}&hub.challenge=1158201444`);
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('1158201444');
    expect((await api().get(`${account.webhookPath}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status).toBe(403);
    expect((await api().get('/api/v1/webhooks/whatsapp/0123456789abcdef0123456789abcdef?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1')).status).toBe(403);
  });

  it('rejects a bad signature and stores nothing', async () => {
    const payload = webhook('9990001112', { messages: [textMessage('wamid.BAD', '919876500001', 'hi')] });
    expect((await postWebhook(account, payload, sign(JSON.stringify(payload), 'another-secret-123456'))).status).toBe(401);
    expect((await postWebhook(account, payload, 'sha256=nothex')).status).toBe(401);
    await inbound.idle();
    expect(await InboundEvent.countDocuments({ eventId: 'message:wamid.BAD' })).toBe(0);
  });

  it('turns a first message into a contact, a WhatsApp lead, a conversation and a message — once', async () => {
    const payload = webhook('9990001112', {
      contacts: [{ profile: { name: 'Meena Stores' }, wa_id: '919876500001' }],
      messages: [textMessage('wamid.A1', '919876500001', 'Price of cumin 1kg?')],
    });
    expect((await postWebhook(account, payload)).status).toBe(200);
    expect((await postWebhook(account, payload)).status).toBe(200); // Meta retry
    await inbound.idle();

    const contact = await Contact.findOne({ phoneE164: '+919876500001' });
    expect(contact).toMatchObject({ name: 'Meena Stores', source: 'WhatsApp', lifecycle: 'lead' });
    const leads = await Lead.find({ contactId: contact._id });
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ source: 'WhatsApp', stage: 'New', sourceRef: 'whatsapp:919876500001' });

    const conversation = await Conversation.findOne({ contactId: contact._id });
    expect(conversation).toMatchObject({ status: 'open', unreadCount: 1, lastMessagePreview: 'Price of cumin 1kg?', lastMessageDirection: 'in' });
    expect(conversation.lastInboundAt.toISOString()).toBe(new Date(1790000000 * 1000).toISOString());
    const messages = await Message.find({ conversationId: conversation._id });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ direction: 'in', type: 'text', text: 'Price of cumin 1kg?', status: 'received', providerMessageId: 'wamid.A1' });
  });

  it('adds later messages (photos too), keeps the newest preview and ignores other numbers of the app', async () => {
    const newer = { from: '919876500001', id: 'wamid.A3', timestamp: '1790000200', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg', sha256: 'abc', caption: 'This one' } };
    const older = textMessage('wamid.A2', '919876500001', 'Also need jeera', '1790000100');
    await postWebhook(account, webhook('9990001112', { messages: [newer, older] }));
    await postWebhook(account, webhook('5555555555', { messages: [textMessage('wamid.X', '919876500009', 'not ours')] }));
    await inbound.idle();

    const contact = await Contact.findOne({ phoneE164: '+919876500001' });
    const conversation = await Conversation.findOne({ contactId: contact._id });
    expect(conversation).toMatchObject({ unreadCount: 3, lastMessagePreview: 'Photo: This one' });
    const photo = await Message.findOne({ providerMessageId: 'wamid.A3' });
    expect(photo).toMatchObject({ type: 'image', text: 'This one', media: { providerMediaId: 'media-1', mimeType: 'image/jpeg' } });
    expect(await Message.countDocuments({ providerMessageId: 'wamid.X' })).toBe(0);
    expect(await Lead.countDocuments({ contactId: contact._id })).toBe(1);
  });

  it('links a message to an existing contact with the same number (no new lead) and reopens a closed chat', async () => {
    const existing = (await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Ravi Traders', phone: '98290 12345', lifecycle: 'customer' })).body.data;
    await postWebhook(account, webhook('9990001112', { contacts: [{ profile: { name: 'ravi' }, wa_id: '919829012345' }], messages: [textMessage('wamid.R1', '919829012345', 'Order status?')] }));
    await inbound.idle();
    const conversation = await Conversation.findOne({ contactId: existing.id });
    expect(conversation).toBeTruthy();
    expect(await Lead.countDocuments({ contactId: existing.id })).toBe(0);
    expect((await Contact.findById(existing.id)).name).toBe('Ravi Traders');

    await Conversation.updateOne({ _id: conversation._id }, { status: 'closed' });
    await postWebhook(account, webhook('9990001112', { messages: [textMessage('wamid.R2', '919829012345', 'Hello again', '1790000500')] }));
    await inbound.idle();
    expect((await Conversation.findById(conversation._id)).status).toBe('open');
  });

  it('moves outgoing messages forward through sent, delivered and read, never back', async () => {
    const conversation = await Conversation.findOne({});
    const sent = await Message.create({
      organizationId: conversation.organizationId, conversationId: conversation._id, contactId: conversation.contactId,
      whatsappAccountId: conversation.whatsappAccountId, direction: 'out', type: 'text', text: 'Rs 250', status: 'sent', providerMessageId: 'wamid.OUT1',
    });
    const status = (name, timestamp, extra = {}) => ({ id: 'wamid.OUT1', status: name, timestamp, recipient_id: '919876500001', ...extra });
    await postWebhook(account, webhook('9990001112', { statuses: [status('read', '1790001000'), status('delivered', '1790000900', { pricing: { billable: false, category: 'service' } })] }));
    await inbound.idle();
    const after = await Message.findById(sent._id);
    expect(after.status).toBe('read');
    expect(after.deliveredAt.toISOString()).toBe(new Date(1790000900 * 1000).toISOString());
    expect(after.pricing).toMatchObject({ billable: false, category: 'service' });

    const failing = await Message.create({
      organizationId: conversation.organizationId, conversationId: conversation._id, contactId: conversation.contactId,
      whatsappAccountId: conversation.whatsappAccountId, direction: 'out', type: 'text', text: 'late', status: 'sent', providerMessageId: 'wamid.OUT2',
    });
    await postWebhook(account, webhook('9990001112', { statuses: [{ id: 'wamid.OUT2', status: 'failed', timestamp: '1790002000', errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'More than 24 hours have passed.' } }] }] }));
    await inbound.idle();
    expect(await Message.findById(failing._id)).toMatchObject({ status: 'failed', error: { code: 131047, message: 'More than 24 hours have passed.' } });
  });

  it('retries events that failed or were left behind', async () => {
    const event = await InboundEvent.create({
      provider: 'whatsapp', eventId: 'message:wamid.LATE', kind: 'message', organizationId: account.organizationId ?? (await WhatsAppAccount.findById(account.id)).organizationId,
      sourceId: account.id, status: 'failed', attempts: 1,
      payload: { message: textMessage('wamid.LATE', '919876500077', 'Left behind'), contact: null },
    });
    await InboundEvent.collection.updateOne({ _id: event._id }, { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } });
    expect(await inbound.retryPending()).toBeGreaterThanOrEqual(1);
    expect((await InboundEvent.findById(event._id)).status).toBe('processed');
    expect(await Message.countDocuments({ providerMessageId: 'wamid.LATE' })).toBe(1);
  });
});

describe('Inbound simulator (development only)', () => {
  it('lets an owner try the inbox without Meta', async () => {
    const owner = await login('sim-owner@example.com');
    const none = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(owner.token)).send({ from: '98111 00011', text: 'Hi' });
    expect(none.body.code).toBe('NO_WHATSAPP_NUMBER');

    const mock = await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock', name: 'Test number' });
    expect(mock.body.data).toMatchObject({ provider: 'mock', status: 'connected', verifiedName: 'Test Business (mock)' });

    const res = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(owner.token)).send({ from: '98111 00011', name: 'Sunita', text: 'Need 10kg jeera' });
    expect(res.status).toBe(201);
    const message = await Message.findById(res.body.data.messageId);
    expect(message).toMatchObject({ direction: 'in', text: 'Need 10kg jeera' });
    expect(await Contact.findOne({ phoneE164: '+919811100011', organizationId: message.organizationId })).toMatchObject({ name: 'Sunita' });

    const agent = await inviteAndJoin(owner.token, 'sim-agent@example.com', { role: 'agent', modules: ['inbox'] });
    expect((await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(agent.token)).send({ from: '98111 00011', text: 'x' })).status).toBe(403);
  });
});
