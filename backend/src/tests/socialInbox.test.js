jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const socialMock = require('../integrations/social/mock');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const InboundEvent = require('../models/InboundEvent');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Message = require('../models/Message');
const SocialAccount = require('../models/SocialAccount');
const inbound = require('../services/whatsappInboundService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// G8 (D112): Instagram and Messenger in the same team inbox — owners and admins connect a Facebook
// Page (its Messenger and its Instagram account); a customer's message becomes a contact, a lead
// and a chat; teammates answer with text (24 hours, then 7 days as a person).
describe('Instagram and Messenger in the inbox (G8, D112)', () => {
  let owner;
  let agent;
  const as = (user) => bearer(user.token);
  const post = (path, body = {}, user = owner) => api().post(`/api/v1${path}`).set(as(user)).send(body);
  const get = (path, user = owner) => api().get(`/api/v1${path}`).set(as(user));
  const reply = (conversationId, text, user = agent) => api().post(`/api/v1/conversations/${conversationId}/messages`).set(as(user)).set('Idempotency-Key', `social-${Math.random()}`).send({ text });
  const simulate = async (body) => {
    const res = await post('/dev/simulate/social-inbound', body);
    expect(res.status).toBe(201);
    await inbound.idle();
    return res.body.data;
  };
  const lastSent = () => socialMock.sent().slice(-1)[0];

  beforeAll(async () => {
    owner = await login('social-owner@example.com', { name: 'Asha Owner' });
    agent = await inviteAndJoin(owner.token, 'social-agent@example.com', { role: 'agent', modules: ['inbox', 'customers'] });
  });

  it('lets owners and admins connect a Page with its Instagram account, and disconnect one', async () => {
    expect((await get('/social', agent)).status).toBe(403);
    const before = (await get('/social')).body.data;
    expect(before).toMatchObject({ accounts: [], connect: { available: false, appId: '' }, devTools: true });
    const real = await post('/social/connect', { code: 'a-code-from-the-popup' });
    expect(real.status).toBe(409);
    expect(real.body.code).toBe('SOCIAL_NOT_SET_UP');
    const added = await post('/social/test');
    expect(added.status).toBe(201);
    expect(added.body.data.accounts.map((a) => [a.channel, a.status, a.provider])).toEqual([['messenger', 'connected', 'mock'], ['instagram', 'connected', 'mock']]);
    expect(added.body.data.accounts[1]).toMatchObject({ username: 'test_shop', accessToken: { configured: true } });
    expect(JSON.stringify(added.body.data)).not.toMatch(/mock-page-/); // the Page's token never leaves the server
  });

  it('puts a new Instagram customer in the inbox as a contact, a lead and a chat; a teammate answers with text', async () => {
    const { from, conversationId } = await simulate({ channel: 'instagram', name: 'Priya Shah', username: 'priya.shop', text: 'Do you ship to Pune?' });
    const chat = await Conversation.findById(conversationId);
    expect(chat).toMatchObject({ channel: 'instagram', socialUserId: from, socialUsername: 'priya.shop', unreadCount: 1, status: 'open' });
    expect(String(chat.whatsappAccountId)).toBe(String(chat.socialAccountId));
    const contact = await Contact.findById(chat.contactId);
    expect(contact).toMatchObject({ name: 'Priya Shah', source: 'Instagram' });
    expect(contact.phoneE164).toBeFalsy();
    const lead = await Lead.findOne({ contactId: contact._id });
    expect(lead).toMatchObject({ source: 'Instagram', sourceRef: `instagram:${from}`, stage: 'New' });
    expect(await LeadActivity.findOne({ leadId: lead._id, text: 'First message on Instagram' })).toBeTruthy();

    const listed = (await get('/conversations?channel=instagram', agent)).body.data;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ channel: 'instagram', social: { username: 'test_shop', customerUsername: 'priya.shop', connected: true }, window: { open: true, humanAgent: false } });
    expect((await get('/conversations?channel=whatsapp', agent)).body.data).toEqual([]);

    const sent = await reply(conversationId, 'Yes, in 3 days');
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ status: 'sent', channel: 'instagram', text: 'Yes, in 3 days' });
    expect(lastSent()).toMatchObject({ channel: 'instagram', recipientId: from, text: 'Yes, in 3 days', humanAgent: false });
    expect(await Message.findOne({ providerMessageId: lastSent().messageId })).toMatchObject({ direction: 'out', channel: 'instagram' });
    // The first reply takes the chat (D25); WhatsApp-only sends are refused clearly.
    expect(String((await Conversation.findById(conversationId)).assigneeId)).toBeTruthy();
    const template = await api().post(`/api/v1/conversations/${conversationId}/messages`).set(as(agent)).send({ type: 'template', templateId: '0123456789abcdef01234567' });
    expect(template.status).toBe(409);
    expect(template.body.code).toBe('WHATSAPP_ONLY');
  });

  it('answers after 24 hours as a person (HUMAN_AGENT), never after 7 days, and keeps the read marks', async () => {
    const { from, conversationId } = await simulate({ channel: 'instagram', name: 'Kabir', text: 'Price?' });
    await Conversation.updateOne({ _id: conversationId }, { $set: { lastInboundAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) } });
    expect((await get(`/conversations/${conversationId}`, agent)).body.data.window).toMatchObject({ open: true, humanAgent: true });
    expect((await reply(conversationId, 'Sorry for the wait: 250 a kg')).status).toBe(201);
    expect(lastSent()).toMatchObject({ recipientId: from, humanAgent: true });
    await simulate({ channel: 'instagram', from, event: 'read' });
    expect(await Message.findOne({ providerMessageId: lastSent().messageId })).toMatchObject({ status: 'read' });

    await Conversation.updateOne({ _id: conversationId }, { $set: { lastInboundAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) } });
    const late = await reply(conversationId, 'Still there?');
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('WINDOW_CLOSED');
  });

  it('keeps Messenger photos in the CRM, and adds what the business sent from Meta\'s apps', async () => {
    const { from, conversationId, messageId } = await simulate({ channel: 'messenger', name: 'Ravi Verma', type: 'image', text: 'This one' });
    const photo = await Message.findById(messageId);
    expect(photo).toMatchObject({ type: 'image', channel: 'messenger', text: 'This one', media: { mimeType: 'image/png' } });
    expect(photo.media.storageKey).toBeTruthy();
    const file = await get(`/conversations/${conversationId}/messages/${messageId}/media`, agent);
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toMatch(/messenger-image-\d{4}-\d{2}-\d{2}\.png/);
    expect((await Contact.findById(photo.contactId)).source).toBe('Messenger');

    // Sent from Business Suite: it may be one of our own replies whose id is not saved yet, so it
    // waits for a retry, then goes into the chat.
    await simulate({ channel: 'messenger', from, event: 'echo', text: 'Sent from the Page inbox' });
    const echo = await InboundEvent.findOne({ kind: 'social_echo' });
    expect(echo.status).toBe('failed');
    await InboundEvent.collection.updateOne({ _id: echo._id }, { $set: { updatedAt: new Date(Date.now() - 5 * 60 * 1000) } });
    await inbound.retryPending();
    expect(await Message.findOne({ conversationId, direction: 'out', origin: 'phone' })).toMatchObject({ text: 'Sent from the Page inbox', channel: 'messenger' });

    // Our own reply's echo is never added twice.
    expect((await reply(conversationId, 'Thanks Ravi')).status).toBe(201);
    const ours = lastSent();
    const payload = {
      object: 'page',
      entry: [{ id: ours.pageId, messaging: [{ sender: { id: ours.pageId }, recipient: { id: from }, timestamp: Date.now(), message: { mid: ours.messageId, is_echo: true, text: 'Thanks Ravi' } }] }],
    };
    await inbound.processNow(await inbound.ingestApp(payload));
    expect(await Message.countDocuments({ providerMessageId: ours.messageId })).toBe(1);
    await simulate({ channel: 'messenger', from, event: 'read' });
    expect(await Message.findOne({ providerMessageId: ours.messageId })).toMatchObject({ status: 'read' });
  });

  it('stops a disconnected account: no new messages, no replies', async () => {
    const { conversationId } = await simulate({ channel: 'messenger', name: 'Meena', text: 'Hi' });
    const account = await SocialAccount.findOne({ channel: 'messenger' });
    expect((await api().delete(`/api/v1/social/accounts/${account._id}`).set(as(owner))).body.data).toMatchObject({ status: 'disconnected', accessToken: { configured: false } });
    const refused = await reply(conversationId, 'Hello');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('ACCOUNT_DISCONNECTED');
    const nothing = await post('/dev/simulate/social-inbound', { channel: 'messenger', text: 'Anyone?' });
    expect(nothing.status).toBe(400); // no connected Messenger account
    expect((await get(`/conversations/${conversationId}`, agent)).body.data.social.connected).toBe(false);
  });
});
