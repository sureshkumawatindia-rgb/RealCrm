jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const WhatsAppAccount = require('../models/WhatsAppAccount');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const queue = require('../jobs/queue');
const env = require('../config/env');
const inbound = require('../services/whatsappInboundService');
const automationEvents = require('../services/automation/events');
const connectService = require('../services/whatsappConnectService');
const fakeMeta = require('./helpers/fakeMeta');
const { api, bearer, login } = require('./helpers/api');

// The platform's app-level webhook (D60, checkpoint 3): a WhatsApp Business app number connected
// with "Connect WhatsApp" sends its contacts, up to 6 months of chats, what the business sends
// from the phone, and new messages — routed to the right company, imported without automations.
const BUSINESS = '919829010001';
const days = (n) => Math.floor((Date.now() - n * 24 * 60 * 60 * 1000) / 1000);

describe('The Meta app webhook (coexistence)', () => {
  let restoreApp;
  let meta;
  let owner;
  let account;
  const post = async (field, value, { wabaId = meta.wabaId, phoneNumberId = meta.phoneNumberId, signed = true } = {}) => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: wabaId, time: Math.floor(Date.now() / 1000), changes: [{ field, value: { messaging_product: 'whatsapp', ...(phoneNumberId && { metadata: { display_phone_number: BUSINESS, phone_number_id: phoneNumberId } }), ...value } }] }],
    });
    const res = await api().post('/api/v1/webhooks/meta').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signed ? fakeMeta.sign(body) : 'sha256=00').send(body);
    await inbound.idle();
    return res;
  };

  beforeAll(async () => {
    connectService.register(queue);
    restoreApp = fakeMeta.enable();
    meta = fakeMeta.install({ displayPhone: '+91 98290 10001' });
    owner = await login('history-owner@example.com');
    const res = await api().post('/api/v1/whatsapp/accounts/embedded-signup').set(bearer(owner.token)).send({ code: 'popup-code-history', wabaId: meta.wabaId, mode: 'coexistence' });
    account = await WhatsAppAccount.findById(res.body.data.id);
    await queue.runDue();
  });
  afterAll(() => {
    meta.restore();
    restoreApp();
  });

  it('answers Meta\'s handshake and refuses unsigned posts', async () => {
    const ok = await api().get('/api/v1/webhooks/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': fakeMeta.APP.webhookVerifyToken, 'hub.challenge': 'ch-123' });
    expect(ok.text).toBe('ch-123');
    expect((await api().get('/api/v1/webhooks/meta').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'x' })).status).toBe(403);
    expect((await post('messages', { messages: [] }, { signed: false })).status).toBe(401);
  });

  it('imports contacts and history quietly: no leads, automations or notifications', async () => {
    const emitted = jest.spyOn(automationEvents, 'emit');
    try {
      await post('smb_app_state_sync', { state_sync: [
        { type: 'contact', contact: { full_name: 'Ramesh Gupta', first_name: 'Ramesh', phone_number: '919829020001' }, action: 'add', metadata: { timestamp: String(days(0)) } },
        { type: 'contact', contact: { full_name: 'Sita Devi', phone_number: '919829020002' }, action: 'add', metadata: { timestamp: String(days(0)) } },
      ] });
      expect(await Contact.findOne({ organizationId: account.organizationId, phoneE164: '+919829020001' })).toMatchObject({ name: 'Ramesh Gupta' });

      const chunk = (phase, progress, threads) => ({ history: [{ metadata: { phase, chunk_order: 1, progress }, threads }] });
      const old = [
        { from: '919829020001', id: 'wamid.H1', timestamp: String(days(40)), type: 'text', text: { body: 'Jeera ka rate kya hai?' }, history_context: { status: 'READ' } },
        { from: BUSINESS, id: 'wamid.H2', timestamp: String(days(40) + 60), type: 'text', text: { body: '₹3,000 per bag' }, history_context: { status: 'READ' } },
      ];
      const recent = [{ from: '919829020002', id: 'wamid.H3', timestamp: String(days(1)), type: 'text', text: { body: 'Order bhej do' } }];
      expect((await post('history', chunk(1, 60, [{ id: '919829020001', messages: old }, { id: '919829020002', messages: recent }]))).status).toBe(200);
      await post('history', chunk(1, 60, [{ id: '919829020001', messages: old }])); // Meta retried: no duplicates

      const messages = await Message.find({ organizationId: account.organizationId }).sort({ createdAt: 1 });
      expect(messages.map((m) => [m.providerMessageId, m.direction, m.status, m.origin])).toEqual([
        ['wamid.H1', 'in', 'received', 'history'], ['wamid.H2', 'out', 'read', 'history'], ['wamid.H3', 'in', 'received', 'history'],
      ]);
      expect(messages[0].createdAt.getTime()).toBe(Number(old[0].timestamp) * 1000); // the real time
      const ramesh = await Contact.findOne({ phoneE164: '+919829020001' });
      const chat = await Conversation.findOne({ contactId: ramesh._id });
      expect(chat).toMatchObject({ status: 'closed', lastMessagePreview: '₹3,000 per bag', lastMessageDirection: 'out', unreadCount: 0 });
      expect((await Conversation.findOne({ contactId: (await Contact.findOne({ phoneE164: '+919829020002' }))._id })).status).toBe('open'); // last week

      expect(await Lead.countDocuments({ organizationId: account.organizationId })).toBe(0);
      expect(await Notification.countDocuments({ organizationId: account.organizationId })).toBe(0);
      expect(emitted).not.toHaveBeenCalled();

      await post('history', chunk(2, 100, []));
      expect((await WhatsAppAccount.findById(account._id)).sync).toMatchObject({ status: 'done', contacts: 2, chats: 2, messages: 3, phase: 2, progress: 100 });
    } finally {
      emitted.mockRestore();
    }
  });

  it('shows what the business sends from the phone, and handles new customer messages like any chat', async () => {
    const emitted = jest.spyOn(automationEvents, 'emit');
    try {
      await post('smb_message_echoes', { message_echoes: [{ from: BUSINESS, to: '919829020001', id: 'wamid.E1', timestamp: String(days(0)), type: 'text', text: { body: 'Kal delivery ho jayegi' } }] });
      const echo = await Message.findOne({ providerMessageId: 'wamid.E1' });
      expect(echo).toMatchObject({ direction: 'out', status: 'sent', origin: 'phone', text: 'Kal delivery ho jayegi' });
      expect(emitted).not.toHaveBeenCalled();
      const list = await api().get(`/api/v1/conversations/${echo.conversationId}/messages`).set(bearer(owner.token));
      expect(list.body.data.find((m) => m.providerMessageId === 'wamid.E1')).toMatchObject({ origin: 'phone' });

      // A new customer writes (live): a lead, the automations, the inbox — as for any number.
      await post('messages', { contacts: [{ wa_id: '919829030003', profile: { name: 'New Buyer' } }], messages: [{ from: '919829030003', id: 'wamid.L1', timestamp: String(days(0)), type: 'text', text: { body: 'Hello, price list?' } }] });
      expect(await Lead.countDocuments({ organizationId: account.organizationId, source: 'WhatsApp' })).toBe(1);
      expect(emitted).toHaveBeenCalledWith('message.received', expect.objectContaining({ text: 'Hello, price list?' }));
    } finally {
      emitted.mockRestore();
    }
  });

  it('keeps every company to its own number, and notes when the business disconnects the CRM', async () => {
    const other = await login('history-other@example.com');
    await post('history', { history: [{ metadata: { phase: 0, chunk_order: 1, progress: 10 }, threads: [{ id: '919829040004', messages: [{ from: '919829040004', id: 'wamid.X1', timestamp: String(days(0)), type: 'text', text: { body: 'Not yours' } }] }] }] }, { phoneNumberId: '2299999999999', wabaId: '1199999999999' });
    expect(await Message.exists({ providerMessageId: 'wamid.X1' })).toBeNull(); // an unknown number is skipped
    const theirs = await api().get('/api/v1/conversations?status=any&view=all').set(bearer(other.token));
    expect(theirs.body.data).toEqual([]);

    expect((await post('history', { history: [{ errors: [{ code: 2593109, title: 'History sync is turned off by the business from the WhatsApp Business App', error_data: { details: 'History sharing is turned off by the business' } }] }] })).status).toBe(200);
    expect((await WhatsAppAccount.findById(account._id)).sync).toMatchObject({ status: 'declined', error: 'History sharing is turned off by the business' });

    await post('account_update', { phone_number: BUSINESS, event: 'PARTNER_REMOVED', disconnection_info: { reason: 'Removed by the business', initiated_by: 'USER' } }, { phoneNumberId: null });
    const after = await WhatsAppAccount.findById(account._id);
    expect(after).toMatchObject({ status: 'disconnected', statusMessage: expect.stringContaining('Removed by the business') });
    expect(after.activePhoneNumberId).toBeUndefined();
  });

  it('is not there until the platform has its Meta app secret', async () => {
    const saved = env.meta.appSecret;
    env.meta.appSecret = '';
    try {
      expect((await api().post('/api/v1/webhooks/meta').send('{}')).status).toBe(404);
    } finally {
      env.meta.appSecret = saved;
    }
  });
});
