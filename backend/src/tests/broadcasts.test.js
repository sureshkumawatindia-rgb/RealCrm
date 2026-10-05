jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const Broadcast = require('../models/Broadcast');
const BroadcastRecipient = require('../models/BroadcastRecipient');
const Contact = require('../models/Contact');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const Organization = require('../models/Organization');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const queue = require('../jobs/queue');
const mock = require('../integrations/whatsapp/mock');
const engine = require('../services/automation/engine');
const sequenceEngine = require('../services/automation/sequences');
const broadcasts = require('../services/broadcastService');
const leadRouting = require('../services/leadRoutingService');
const inbound = require('../services/whatsappInboundService');
const { estimateCost } = require('../constants/whatsappPricing');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const settle = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};
// Batches follow each other a second apart: let the next one be due now.
const nextBatches = async () => {
  for (let i = 0; i < 6; i += 1) {
    await mongoose.model('Job').updateMany({ name: 'broadcast.send', status: 'queued' }, { $set: { runAt: new Date() } });
    await settle(1);
  }
};

beforeAll(() => {
  leadRouting.attach(queue);
  engine.register(queue);
  sequenceEngine.register(queue);
  broadcasts.register(queue);
});
afterAll(() => queue.stop());

describe('Broadcast arithmetic', () => {
  it('knows the month in India time and estimates Meta\'s cost by category', () => {
    expect(broadcasts.monthStart(new Date('2026-10-31T19:00:00Z')).toISOString()).toBe('2026-10-31T18:30:00.000Z'); // 1 Nov 00:30 IST
    expect(broadcasts.monthStart(new Date('2026-10-15T10:00:00Z')).toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(estimateCost(1000, 'MARKETING')).toMatchObject({ perMessagePaise: 86.31, paise: 86310, gstPaise: 15536, totalPaise: 101846, currency: 'INR' });
    expect(estimateCost(3, 'utility')).toMatchObject({ paise: 35, gstPaise: 7 });
    expect(broadcasts.dailyLimitOf({ messagingLimit: 'TIER_2K' })).toBe(2000);
    expect(broadcasts.dailyLimitOf({ messagingLimit: '' })).toBe(250);
  });
});

describe('WhatsApp broadcasts', () => {
  let owner;
  let account;
  let templates;
  let segment;
  let sent = [];
  let wamids = 0;
  let refuse = new Set();
  const auth = () => bearer(owner.token);
  const post = (path, body) => api().post(`/api/v1${path}`).set(auth()).send(body);
  const welcome = { body: { 1: 'contact.name', 2: 'text:your Diwali order' } };
  const statusWebhook = async (wamid, status) => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'simulated', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: account.phoneNumberId }, statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '91' }] } }] }],
    };
    await inbound.processNow(await inbound.ingest(account, payload));
  };

  beforeAll(async () => {
    owner = await login('broadcast-owner@example.com', { name: 'Asha' });
    await api().patch('/api/v1/organization').set(auth()).send({ name: 'Yellow Traders' });
    await post('/whatsapp/accounts', { provider: 'mock' });
    account = await WhatsAppAccount.findOne({ organizationId: (await Organization.findOne({ name: 'Yellow Traders' }))._id });
    templates = Object.fromEntries((await post('/templates/sync', {})).body.data.map((t) => [t.name, t]));
    for (let i = 1; i <= 25; i += 1) {
      await post('/contacts', { name: `Rajasthan Buyer ${i}`, phone: `98290 9${String(i).padStart(4, '0')}`, state: 'Rajasthan', tags: ['Tier A'] });
    }
    await post('/contacts', { name: 'Said No', phone: '98290 99001', state: 'Rajasthan', tags: ['Tier A'], marketingConsent: 'opted_out' });
    await post('/contacts', { name: 'No Phone', email: 'nophone@example.com', state: 'Rajasthan', tags: ['Tier A'] });
    await post('/contacts', { name: 'Gujarat Buyer', phone: '98290 99002', state: 'Gujarat', tags: ['Tier A'] });
    segment = (await post('/segments', { name: 'Tier A – Rajasthan', filters: { tagsAll: ['Tier A'], states: ['Rajasthan'] } })).body.data;
  });
  beforeEach(() => {
    sent = [];
    refuse = new Set();
    jest.spyOn(mock, 'sendMessage').mockImplementation(async (credentials, body) => {
      if (refuse.has(body.to)) throw Object.assign(new Error('(#131026) Message undeliverable'), { providerCode: 131026 });
      sent.push(body);
      wamids += 1;
      return { providerMessageId: `wamid.BC${wamids}` };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('saves drafts for owners and admins with a sendable template, filled in completely', async () => {
    expect((await api().get('/api/v1/broadcasts/quota').set(auth())).body.data).toEqual({ plan: 'Growth', limit: 500, used: 0, left: 500 });
    const codes = async (body) => (await post('/broadcasts', { name: 'x', segmentId: segment.id, ...body })).body.errors?.[0]?.code;
    expect(await codes({ templateId: templates.diwali_offer.id })).toBe('TEMPLATE_NOT_SENDABLE');
    expect(await codes({ templateId: templates.quotation_pdf.id })).toBe('TEMPLATE_NOT_SENDABLE');
    expect(await codes({ templateId: templates.order_update.id, variables: { body: { 1: 'contact.name' } } })).toBe('VARIABLE_REQUIRED');
    const stranger = await login('broadcast-stranger@example.com');
    const theirs = (await api().post('/api/v1/segments').set(bearer(stranger.token)).send({ name: 'Theirs' })).body.data;
    expect(await codes({ templateId: templates.order_update.id, variables: welcome, segmentId: theirs.id })).toBe('INVALID_SEGMENT');
    const agent = await inviteAndJoin(owner.token, 'broadcast-agent@example.com', { role: 'agent', modules: ['marketing'] });
    expect((await api().get('/api/v1/broadcasts').set(bearer(agent.token))).status).toBe(403);

    const draft = await post('/broadcasts', { name: 'Diwali update', templateId: templates.order_update.id, variables: welcome, segmentId: segment.id });
    expect(draft.status).toBe(201);
    expect(draft.body.data).toMatchObject({ status: 'draft', template: { name: 'order_update', category: 'UTILITY' }, segment: { name: 'Tier A – Rajasthan' }, stats: { total: 0 } });
    const estimate = (await api().get(`/api/v1/broadcasts/${draft.body.data.id}/estimate`).set(auth())).body.data;
    expect(estimate).toMatchObject({
      recipients: 25, // not the opted-out one, not the one without a mobile, not Gujarat
      cost: { perMessagePaise: 11.5, paise: 288, gstPaise: 52, currency: 'INR' },
      quota: { limit: 500, used: 0 }, dailyLimit: { limit: 250, tier: 'TIER_250', usedToday: 0, leftToday: 250 },
    });
    expect((await api().get(`/api/v1/broadcasts/${draft.body.data.id}`).set(bearer(stranger.token))).status).toBe(404);
  });

  it('sends in batches, each customer\'s own values, and tracks delivered, read, replies and failures', async () => {
    const broadcast = (await post('/broadcasts', { name: 'Diwali dispatch', templateId: templates.order_update.id, variables: welcome, segmentId: segment.id })).body.data;
    refuse.add('919829090007');
    // Buyer 3 opts out after the list was fixed (before their batch).
    const started = await api().post(`/api/v1/broadcasts/${broadcast.id}/send`).set(auth()).set('Idempotency-Key', 'bc-send-1').send({});
    expect(started.status).toBe(200);
    expect(started.body.message).toBe('Broadcast started');
    await settle(1); // the start: the list is fixed and the first batch goes
    await Contact.updateOne({ phoneE164: '+919829090023' }, { $set: { 'consent.marketing': 'opted_out' } });
    await nextBatches();

    const done = (await api().get(`/api/v1/broadcasts/${broadcast.id}`).set(auth())).body.data;
    expect(done).toMatchObject({ status: 'completed', stats: { total: 25, pending: 0, sent: 23, failed: 1, skipped: 1 }, estimate: { recipients: 25 } });
    expect(sent).toHaveLength(23);
    expect(sent[0]).toMatchObject({ type: 'template', template: { name: 'order_update', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Rajasthan Buyer 1' }, { type: 'text', text: 'your Diwali order' }] }] } });
    const failed = await BroadcastRecipient.findOne({ broadcastId: broadcast.id, status: 'failed' });
    expect(failed).toMatchObject({ name: 'Rajasthan Buyer 7', reason: expect.stringMatching(/undeliverable/) });
    expect((await BroadcastRecipient.findOne({ broadcastId: broadcast.id, status: 'skipped' })).reason).toBe('Opted out of WhatsApp offers.');
    expect(await Notification.exists({ title: 'Broadcast "Diwali dispatch" sent', body: '23 sent · 1 failed · 1 skipped' })).toBeTruthy();
    const message = await Message.findOne({ 'automation.kind': 'broadcast', 'automation.ruleId': broadcast.id });
    expect(message).toMatchObject({ type: 'template', status: 'sent' });

    // WhatsApp reports back: delivered, read (one read without a delivered first), a late failure.
    const [first, second, third] = await BroadcastRecipient.find({ broadcastId: broadcast.id, status: 'sent' }).sort({ name: 1 }).populate('messageId');
    await statusWebhook(first.messageId.providerMessageId, 'delivered');
    await statusWebhook(first.messageId.providerMessageId, 'read');
    await statusWebhook(second.messageId.providerMessageId, 'read');
    await statusWebhook(third.messageId.providerMessageId, 'failed');
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(await BroadcastRecipient.findById(first._id)).toMatchObject({ status: 'read' });
    expect((await BroadcastRecipient.findById(second._id)).deliveredAt).toBeTruthy();
    expect(await BroadcastRecipient.findById(third._id)).toMatchObject({ status: 'failed' });

    // A customer writes back.
    await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(auth()).send({ from: first.phoneE164, name: first.name, text: 'Thank you!' });
    await settle();
    const stats = (await api().get(`/api/v1/broadcasts/${broadcast.id}`).set(auth())).body.data.stats;
    expect(stats).toMatchObject({ sent: 23, delivered: 2, read: 2, replied: 1, failed: 2 });
    const people = (await api().get(`/api/v1/broadcasts/${broadcast.id}/recipients?status=replied`).set(auth())).body.data;
    expect(people).toMatchObject([{ name: first.name, status: 'replied', repliedAt: expect.any(String), readAt: expect.any(String) }]);
    expect((await api().get('/api/v1/broadcasts/quota').set(auth())).body.data.used).toBe(1);
    expect((await api().delete(`/api/v1/broadcasts/${broadcast.id}`).set(auth())).body.code).toBe('BROADCAST_STARTED');
  });

  it('skips customers without a value and waits when Meta\'s daily limit is used up', async () => {
    const tagged = (await post('/segments', { name: 'Gujarat', filters: { states: ['Gujarat'] } })).body.data;
    const companyTemplate = { header: { product: 'contact.company' }, body: { customer_name: 'contact.name' } };
    const offer = (await post('/broadcasts', { name: 'Offer', templateId: templates.quote_follow_up.id, variables: companyTemplate, segmentId: tagged.id })).body.data;
    expect(offer.template.category).toBe('MARKETING');
    await api().post(`/api/v1/broadcasts/${offer.id}/send`).set(auth()).send({});
    await settle(1);
    await nextBatches();
    expect(await BroadcastRecipient.findOne({ broadcastId: offer.id })).toMatchObject({ status: 'skipped', reason: 'No value for {{product}}.' });

    // 250 people already got a template today: the next broadcast waits for room.
    const organizationId = account.organizationId;
    await Message.insertMany(Array.from({ length: 250 }, (_, i) => ({
      organizationId, conversationId: new mongoose.Types.ObjectId(), contactId: new mongoose.Types.ObjectId(), whatsappAccountId: account._id,
      direction: 'out', type: 'template', status: 'delivered', text: `x${i}`,
    })));
    const waiting = (await post('/broadcasts', { name: 'Too many today', templateId: templates.order_update.id, variables: welcome, segmentId: segment.id })).body.data;
    await api().post(`/api/v1/broadcasts/${waiting.id}/send`).set(auth()).send({});
    await settle(2);
    const held = await Broadcast.findById(waiting.id);
    expect(held.status).toBe('sending');
    expect(held.waitUntil.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    // 24: Buyer 23 opted out during the last broadcast.
    expect(await BroadcastRecipient.countDocuments({ broadcastId: waiting.id, status: 'pending' })).toBe(24);
    expect(sent).toHaveLength(0);
    const estimate = (await api().get(`/api/v1/broadcasts/${waiting.id}/estimate`).set(auth())).body.data;
    expect(estimate.dailyLimit.leftToday).toBe(0);
    expect(estimate.dailyLimit.usedToday).toBeGreaterThanOrEqual(250);

    // Pause, resume, cancel: the pending ones are skipped.
    await api().post(`/api/v1/broadcasts/${waiting.id}/pause`).set(auth());
    expect((await Broadcast.findById(waiting.id)).status).toBe('paused');
    await api().post(`/api/v1/broadcasts/${waiting.id}/resume`).set(auth());
    const cancelled = (await api().post(`/api/v1/broadcasts/${waiting.id}/cancel`).set(auth())).body.data;
    expect(cancelled).toMatchObject({ status: 'cancelled', stats: { skipped: 24, pending: 0 } });
    await Message.deleteMany({ text: /^x\d+$/ });
  });

  it('schedules for later, and stops at the plan\'s monthly number', async () => {
    const later = (await post('/broadcasts', { name: 'Tomorrow', templateId: templates.order_update.id, variables: welcome, segmentId: segment.id })).body.data;
    const at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const scheduled = await api().post(`/api/v1/broadcasts/${later.id}/send`).set(auth()).send({ scheduledAt: at });
    expect(scheduled.body).toMatchObject({ message: 'Broadcast scheduled', data: { status: 'scheduled', scheduledAt: at } });
    await settle();
    expect(await BroadcastRecipient.countDocuments({ broadcastId: later.id })).toBe(0);
    await api().post(`/api/v1/broadcasts/${later.id}/cancel`).set(auth());
    expect((await api().delete(`/api/v1/broadcasts/${later.id}`).set(auth())).status).toBe(200);

    // The Starter plan allows 10 a month.
    await Organization.updateOne({ _id: account.organizationId }, { $set: { plan: 'starter' } });
    await Broadcast.insertMany(Array.from({ length: 9 }, (_, i) => ({ organizationId: account.organizationId, name: `Old ${i}`, status: 'completed', templateId: templates.order_update.id, segmentId: segment.id, startedAt: new Date() })));
    const over = (await post('/broadcasts', { name: 'One too many', templateId: templates.order_update.id, variables: welcome, segmentId: segment.id })).body.data;
    const refused = await api().post(`/api/v1/broadcasts/${over.id}/send`).set(auth()).send({});
    expect(refused.body).toMatchObject({ code: 'QUOTA_REACHED', message: 'Your Starter plan allows 10 broadcasts a month; this month\'s are used up.' });
    expect((await api().get('/api/v1/broadcasts?limit=50').set(auth())).body.data.map((b) => b.name)).toContain('One too many');
  });
});
