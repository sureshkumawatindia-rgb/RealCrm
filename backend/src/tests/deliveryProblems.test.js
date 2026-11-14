jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const Broadcast = require('../models/Broadcast');
const BroadcastRecipient = require('../models/BroadcastRecipient');
const Job = require('../models/Job');
const Message = require('../models/Message');
const SmsMessage = require('../models/SmsMessage');
const WebhookDelivery = require('../models/WebhookDelivery');
const WebhookSubscription = require('../models/WebhookSubscription');
const queue = require('../jobs/queue');
const mock = require('../integrations/whatsapp/mock');
const sms = require('../integrations/sms');
const smsService = require('../services/smsService');
const messageRetry = require('../services/messageRetryService');
const inbound = require('../services/whatsappInboundService');
const httpError = require('../utils/httpError');
const { encrypt } = require('../utils/secretBox');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 9 of the 100 phases (D151): Settings → Failed sends. Everything of the last 7 days that
// did not go, with the reason and "Try again"; and an SMS tried again by itself.
const DAY = 24 * 60 * 60 * 1000;
const refusal = (text = 'This number is not on WhatsApp.') => Object.assign(httpError(400, 'WHATSAPP_ERROR', text), { providerCode: 131026, temporary: false });
const TEMPLATES = [{ name: 'Follow-up', flowId: 'flow-1', text: 'Dear ##name##, your quote is ready.' }];
const smsDue = async () => {
  await Job.updateMany({ name: 'sms.retry', status: 'queued' }, { $set: { runAt: new Date() } });
  await queue.runDue();
};

describe('Failed sends', () => {
  let owner;
  let admin;
  let agent;
  let other;
  let chat;
  let lead;
  let templateKey;
  const O = () => new mongoose.Types.ObjectId(owner.data.organizationId);
  const list = (who, query = '') => api().get(`/api/v1/delivery-problems${query}`).set(bearer(who.token));
  const retry = (who, kind, id) => api().post(`/api/v1/delivery-problems/${kind}/${id}/retry`).set(bearer(who.token)).send({});
  const say = (text) => api().post(`/api/v1/conversations/${chat}/messages`).set(bearer(owner.token)).send({ text });
  const sendSms = (key) => api().post('/api/v1/sms').set(bearer(owner.token)).set('Idempotency-Key', key).send({ contactId: lead.contactId, template: templateKey, values: { name: 'Verma' } });

  beforeAll(async () => {
    messageRetry.register(queue);
    smsService.register(queue);
    owner = await login('dp-owner@example.com', { name: 'Owner' });
    admin = await inviteAndJoin(owner.token, 'dp-admin@example.com', { role: 'admin' });
    agent = await inviteAndJoin(owner.token, 'dp-agent@example.com', { role: 'agent', modules: ['inbox'] });
    other = await login('dp-other@example.com');
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
    const made = await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(bearer(owner.token)).send({ from: '98290 22001', text: 'Rate?', name: 'Sunita' });
    await inbound.idle();
    chat = made.body.data.conversationId;
    const saved = await api().put('/api/v1/sms/connection').set(bearer(owner.token)).send({ provider: 'mock', senderId: 'YELLOW', templates: TEMPLATES });
    templateKey = saved.body.data.templates[0].key;
    lead = (await api().post('/api/v1/leads').set(bearer(owner.token)).send({ title: 'Granite', contact: { name: 'Verma Stones', phone: '+919829080611' } })).body.data;
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    mock.setTrouble(false);
    sms.mock.reset();
    await Promise.all([Message.deleteMany({ direction: 'out' }), SmsMessage.deleteMany({}), WebhookDelivery.deleteMany({}), BroadcastRecipient.deleteMany({}), Job.deleteMany({})]);
  });
  afterAll(async () => {
    mock.setTrouble(false);
    await queue.stop();
  });

  it('is for owners and admins', async () => {
    expect((await list(owner)).status).toBe(200);
    expect((await list(admin)).status).toBe(200);
    expect((await list(agent)).status).toBe(403);
    expect((await api().get('/api/v1/delivery-problems')).status).toBe(401);
  });

  it('lists every kind with the reason, newest first, with counts and a filter', async () => {
    jest.spyOn(mock, 'sendMessage').mockRejectedValueOnce(refusal());
    const failed = (await say('Failed one')).body.data;
    mock.setTrouble(true);
    const waiting = (await say('Waiting one')).body.data;
    mock.setTrouble(false);
    sms.mock.failNext({ message: 'DLT template mismatch' });
    await sendSms('sms-list-1');
    const sub = await WebhookSubscription.create({ organizationId: O(), url: 'https://erp.shop.example/hook', events: ['lead.created'], secretEnc: encrypt('s'), description: 'Our ERP' });
    const delivery = await WebhookDelivery.create({ organizationId: O(), subscriptionId: sub._id, eventId: 'evt_1', event: 'lead.created', status: 'failed', attempts: 5, responseCode: 500 });
    const broadcast = await Broadcast.collection.insertOne({ organizationId: O(), name: 'Diwali offer' });
    await BroadcastRecipient.create([
      { organizationId: O(), broadcastId: broadcast.insertedId, contactId: lead.contactId, status: 'failed', failedAt: new Date(), reason: 'Not on WhatsApp' },
      { organizationId: O(), broadcastId: broadcast.insertedId, contactId: new mongoose.Types.ObjectId(), status: 'failed', failedAt: new Date(), reason: 'Not on WhatsApp' },
    ]);

    const res = await list(owner);
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ failed: 4, waiting: 1, counts: { chat: { failed: 1, waiting: 1 }, sms: { failed: 1, waiting: 0 }, webhook: { failed: 1, waiting: 0 }, broadcast: { failed: 1, waiting: 0 } } });
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 30, total: 5 });
    const by = (kind, state) => res.body.data.find((i) => i.kind === kind && (!state || i.state === state));
    expect(by('chat', 'failed')).toMatchObject({ id: failed.id, customer: 'Sunita', what: 'Failed one', reason: 'This number is not on WhatsApp.', canRetry: true, conversationId: chat, automatic: false });
    expect(by('chat', 'waiting')).toMatchObject({ id: waiting.id, what: 'Waiting one', reason: expect.stringMatching(/Could not reach/), canRetry: false, nextAt: expect.any(String) });
    expect(by('sms')).toMatchObject({ customer: 'Verma Stones', what: 'Dear Verma, your quote is ready.', reason: 'DLT template mismatch', canRetry: true });
    expect(by('webhook')).toMatchObject({ id: String(delivery._id), customer: 'Our ERP', what: 'lead.created', reason: 'HTTP 500', canRetry: true });
    expect(by('broadcast')).toMatchObject({ customer: 'Diwali offer', count: 2, reason: 'Not on WhatsApp', canRetry: false });
    const times = res.body.data.map((i) => new Date(i.at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));

    const onlySms = await list(owner, '?kind=sms');
    expect(onlySms.body.data.map((i) => i.kind)).toEqual(['sms']);
    expect(onlySms.body.pagination.total).toBe(1);
    expect((await list(owner, '?limit=2&page=2')).body.data).toHaveLength(2);
    expect((await list(owner, '?kind=nothing')).status).toBe(400);
    // Another company sees none of it, and cannot touch it.
    expect((await list(other)).body.summary).toMatchObject({ failed: 0, waiting: 0 });
    expect((await retry(other, 'chat', failed.id)).status).toBe(404);
    expect((await retry(other, 'webhook', delivery._id)).status).toBe(404);
  });

  it('keeps to the last 7 days, and leaves out messages that belong to a broadcast', async () => {
    jest.spyOn(mock, 'sendMessage').mockRejectedValue(refusal());
    const old = (await say('Old')).body.data;
    const part = (await say('Part of a broadcast')).body.data;
    await Message.collection.updateOne({ _id: new mongoose.Types.ObjectId(old.id) }, { $set: { createdAt: new Date(Date.now() - 8 * DAY) } });
    await Message.updateOne({ _id: part.id }, { $set: { automation: { kind: 'broadcast' } } });
    expect((await list(owner)).body.summary.failed).toBe(0);
  });

  it('a private number\'s messages are for owners only', async () => {
    jest.spyOn(mock, 'sendMessage').mockRejectedValue(refusal());
    const secret = (await say('Private matter')).body.data;
    await Message.updateOne({ _id: secret.id }, { $set: { private: true } });
    expect((await list(owner)).body.summary.counts.chat.failed).toBe(1);
    const seen = await list(admin);
    expect(seen.body.summary.counts.chat.failed).toBe(0);
    expect(seen.body.data).toEqual([]);
  });

  it('"Try again" for a chat message and a webhook', async () => {
    jest.spyOn(mock, 'sendMessage').mockRejectedValueOnce(refusal());
    const failed = (await say('Again please')).body.data;
    const again = await retry(admin, 'chat', failed.id);
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe('sent');
    expect((await list(owner)).body.summary.failed).toBe(0);

    const sub = await WebhookSubscription.create({ organizationId: O(), url: 'https://erp.shop.example/hook', events: ['lead.created'], secretEnc: encrypt('s') });
    const delivery = await WebhookDelivery.create({ organizationId: O(), subscriptionId: sub._id, eventId: 'evt_2', event: 'lead.created', status: 'failed', attempts: 5, error: 'Timed out' });
    expect((await retry(owner, 'webhook', delivery._id)).status).toBe(200);
    expect(await WebhookDelivery.findById(delivery._id).lean()).toMatchObject({ status: 'pending', attempts: 0, error: '' });
    expect(await Job.countDocuments({ name: 'webhook.deliver' })).toBe(1);
    expect((await retry(owner, 'broadcast', delivery._id)).status).toBe(400);
  });

  describe('an SMS', () => {
    it('that MSG91 could not take goes again by itself, 4 times at the most', async () => {
      sms.mock.failNext({ retryable: true, message: 'MSG91 is down' });
      expect((await sendSms('sms-retry-1')).status).toBe(502);
      const stored = await SmsMessage.findOne({}).lean();
      expect(stored).toMatchObject({ status: 'failed', retryable: true, values: { name: 'Verma' }, tries: 1 });
      const job = await Job.findOne({ name: 'sms.retry' }).lean();
      expect(job.runAt.getTime() - Date.now()).toBeGreaterThan(90 * 1000);

      // Fails again, then again, then goes.
      sms.mock.failNext({ retryable: true }, { retryable: true });
      await smsDue();
      expect((await SmsMessage.findOne({}).lean()).tries).toBe(2);
      await smsDue();
      expect((await SmsMessage.findOne({}).lean()).tries).toBe(3);
      await smsDue();
      expect(await SmsMessage.findOne({}).lean()).toMatchObject({ status: 'sent', retryable: false, error: '', tries: 4 });
      expect(sms.mock.sent()).toHaveLength(1);
      expect(sms.mock.sent()[0].values).toEqual({ name: 'Verma' });
      expect(await Job.countDocuments({ name: 'sms.retry', status: 'queued' })).toBe(0);

      // Every try failing: it stops.
      sms.mock.failNext(...Array.from({ length: 5 }, () => ({ retryable: true })));
      await sendSms('sms-retry-2');
      for (let i = 0; i < 5; i += 1) await smsDue();
      expect(await SmsMessage.findOne({ idempotencyKey: { $regex: 'sms-retry-2' } }).lean()).toMatchObject({ status: 'failed', retryable: true, tries: 5 });
      expect(await Job.countDocuments({ name: 'sms.retry', status: 'queued' })).toBe(0);
    });

    it('that was refused does not go by itself; "Try again" sends it, once', async () => {
      sms.mock.failNext({ message: 'Blocked by DLT' });
      await sendSms('sms-manual-1');
      expect(await Job.countDocuments({ name: 'sms.retry' })).toBe(0);
      const { id } = (await list(owner, '?kind=sms')).body.data[0];
      const [a, b] = await Promise.all([retry(owner, 'sms', id), retry(owner, 'sms', id)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(sms.mock.sent()).toHaveLength(1);
      expect((await list(owner, '?kind=sms')).body.data).toEqual([]);
    });

    it('is not sent again to a customer who asked for no SMS', async () => {
      sms.mock.failNext({ retryable: true });
      await sendSms('sms-optout-1');
      await require('../models/Contact').updateOne({ _id: lead.contactId }, { $set: { smsOptOut: { at: new Date() } } }); // eslint-disable-line global-require
      const message = await SmsMessage.findOne({}).lean();
      const res = await retry(owner, 'sms', message._id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CANNOT_RESEND');
      expect(sms.mock.sent()).toHaveLength(0);
      expect(await SmsMessage.findById(message._id).lean()).toMatchObject({ status: 'failed', retryable: false, error: 'The customer asked not to get SMS.' });
      await smsDue();
      expect(sms.mock.sent()).toHaveLength(0);
      await require('../models/Contact').updateOne({ _id: lead.contactId }, { $unset: { smsOptOut: 1 } }); // eslint-disable-line global-require
    });
  });
});
