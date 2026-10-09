jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const queue = require('../jobs/queue');
const inbound = require('../services/whatsappInboundService');
const connectService = require('../services/whatsappConnectService');
const fakeMeta = require('./helpers/fakeMeta');
const { api, bearer, login } = require('./helpers/api');

// D60 acceptance: the whole path a company owner takes, through the real code with Meta faked —
// Google login, "Connect WhatsApp" (Embedded Signup with the WhatsApp Business app number),
// contacts and 6 months of chats imported quietly, a new customer's message, a reply from the
// CRM, its delivery, a reply sent from the phone; another company sees none of it and cannot take
// the number; a number connected by hand keeps working on its own webhook.
const BUSINESS = '919829010001';
const now = () => Math.floor(Date.now() / 1000);

describe('D60 acceptance: Connect WhatsApp and real chats', () => {
  let restoreApp;
  let meta;
  beforeAll(() => {
    connectService.register(queue);
    restoreApp = fakeMeta.enable();
    meta = fakeMeta.install({ displayPhone: '+91 98290 10001', verifiedName: 'Shree Ganesh Traders' });
  });
  afterAll(() => {
    meta.restore();
    restoreApp();
  });

  const metaWebhook = async (field, value) => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: meta.wabaId, time: now(), changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: BUSINESS, phone_number_id: meta.phoneNumberId }, ...value } }] }],
    });
    const res = await api().post('/api/v1/webhooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', fakeMeta.sign(body)).send(body);
    await inbound.idle();
    return res;
  };

  it('runs from the first login to a reply, with nothing fake shown on the way', async () => {
    // 1. The owner logs in with Google; WhatsApp is not connected yet.
    const owner = await login('acceptance-owner@example.com', { name: 'Ramesh Kumar' });
    const before = (await api().get('/api/v1/whatsapp/connect').set(bearer(owner.token))).body.data;
    expect(before).toMatchObject({ available: true, connected: false, devTools: true });

    // 2. Meta's popup → the server connects the WhatsApp Business app number.
    const connected = await api().post('/api/v1/whatsapp/accounts/embedded-signup').set(bearer(owner.token))
      .send({ code: 'popup-code-acceptance', wabaId: meta.wabaId, mode: 'coexistence' });
    expect(connected.status).toBe(201);
    expect(connected.body.data).toMatchObject({ connectionType: 'coexistence', verifiedName: 'Shree Ganesh Traders', status: 'connected' });
    await queue.runDue();
    expect(meta.calls.filter((call) => call.path.endsWith('/smb_app_data')).map((call) => call.body.sync_type)).toEqual(['smb_app_state_sync', 'history']);

    // 3. Meta sends the contacts and the history: imported, without leads or notifications.
    await metaWebhook('smb_app_state_sync', { state_sync: [{ type: 'contact', contact: { full_name: 'Sita Devi', phone_number: '919829020002' }, action: 'add', metadata: { timestamp: String(now()) } }] });
    await metaWebhook('history', { history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads: [{ id: '919829020002', messages: [
      { from: '919829020002', id: 'wamid.A1', timestamp: String(now() - 3600), type: 'text', text: { body: 'Bhaiya 10 bag jeera bhej do' } },
      { from: BUSINESS, id: 'wamid.A2', timestamp: String(now() - 3500), type: 'text', text: { body: 'Ji, aaj shaam tak' }, history_context: { status: 'READ' } },
    ] }] }] });
    await metaWebhook('history', { history: [{ metadata: { phase: 2, chunk_order: 1, progress: 100 }, threads: [] }] });
    const status = (await api().get('/api/v1/whatsapp/connect').set(bearer(owner.token))).body.data;
    expect(status).toMatchObject({ connected: true });
    expect(status.accounts[0].sync).toMatchObject({ status: 'done', chats: 1, messages: 2, contacts: 1 });
    expect(await Lead.countDocuments({ organizationId: owner.data.organizationId })).toBe(0);
    expect(await Notification.countDocuments({ organizationId: owner.data.organizationId })).toBe(0);
    const chats = (await api().get('/api/v1/conversations?status=any').set(bearer(owner.token))).body.data;
    expect(chats).toEqual([expect.objectContaining({ contact: expect.objectContaining({ name: 'Sita Devi' }), lastMessagePreview: 'Ji, aaj shaam tak' })]);

    // 4. A new customer writes: a WhatsApp lead and an open, unread chat.
    await metaWebhook('messages', { contacts: [{ wa_id: '919829030003', profile: { name: 'Naya Customer' } }], messages: [{ from: '919829030003', id: 'wamid.A3', timestamp: String(now()), type: 'text', text: { body: 'Haldi ka rate?' } }] });
    const lead = await Lead.findOne({ organizationId: owner.data.organizationId, source: 'WhatsApp' });
    expect(lead).toBeTruthy();
    const open = (await api().get('/api/v1/conversations').set(bearer(owner.token))).body.data;
    const live = open.find((chat) => chat.contact.name === 'Naya Customer');
    expect(live).toMatchObject({ status: 'open', unreadCount: 1 });

    // 5. The owner replies from the CRM: it goes to Meta with the business token, then is delivered.
    const reply = await api().post(`/api/v1/conversations/${live.id}/messages`).set(bearer(owner.token)).set('Idempotency-Key', crypto.randomUUID()).send({ text: 'Haldi 1kg ₹180' });
    expect(reply.status).toBe(201);
    const send = meta.calls.find((call) => call.path === `${meta.phoneNumberId}/messages`);
    expect(send).toMatchObject({ auth: `Bearer ${meta.token}`, body: expect.objectContaining({ to: '919829030003', text: expect.objectContaining({ body: 'Haldi 1kg ₹180' }) }) });
    const sentMessage = await Message.findOne({ conversationId: live.id, direction: 'out' });
    await metaWebhook('messages', { statuses: [{ id: sentMessage.providerMessageId, status: 'delivered', timestamp: String(now()), recipient_id: '919829030003' }] });
    expect((await Message.findById(sentMessage._id)).status).toBe('delivered');

    // 6. The owner answers Sita from the phone: it shows in her chat as "sent from phone".
    await metaWebhook('smb_message_echoes', { message_echoes: [{ from: BUSINESS, to: '919829020002', id: 'wamid.A4', timestamp: String(now()), type: 'text', text: { body: 'Dispatch ho gaya' } }] });
    const sita = await Contact.findOne({ organizationId: owner.data.organizationId, phoneE164: '+919829020002' });
    const sitaMessages = await Message.find({ contactId: sita._id }).sort({ createdAt: 1 });
    expect(sitaMessages.map((m) => [m.text, m.direction, m.origin])).toEqual([
      ['Bhaiya 10 bag jeera bhej do', 'in', 'history'], ['Ji, aaj shaam tak', 'out', 'history'], ['Dispatch ho gaya', 'out', 'phone'],
    ]);

    // 7. Another company sees none of it and cannot take the number.
    const other = await login('acceptance-other@example.com');
    expect((await api().get('/api/v1/conversations?status=any&view=all').set(bearer(other.token))).body.data).toEqual([]);
    expect((await api().post('/api/v1/whatsapp/accounts/embedded-signup').set(bearer(other.token)).send({ code: 'popup-code-other', wabaId: meta.wabaId })).body.code).toBe('NUMBER_IN_USE');

    // 8. A number connected by hand (its own Meta app and webhook URL) keeps working.
    const manual = (await api().post('/api/v1/whatsapp/accounts').set(bearer(other.token)).send({ phoneNumberId: '2200000000777', wabaId: '1100000000777', accessToken: 'EAAB-manual-token-123', appSecret: 'manual-app-secret-0123456789' })).body.data;
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1100000000777', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '2200000000777' }, contacts: [{ wa_id: '919829040004', profile: { name: 'Manual Buyer' } }], messages: [{ from: '919829040004', id: 'wamid.M1', timestamp: String(now()), type: 'text', text: { body: 'Hello' } }] } }] }] });
    const manualSignature = `sha256=${crypto.createHmac('sha256', 'manual-app-secret-0123456789').update(raw).digest('hex')}`;
    expect((await api().post(manual.webhookPath).set('Content-Type', 'application/json').set('X-Hub-Signature-256', manualSignature).send(raw)).status).toBe(200);
    await inbound.idle();
    expect(await Message.findOne({ providerMessageId: 'wamid.M1' })).toMatchObject({ direction: 'in', text: 'Hello' });
  });
});
