jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const WebhookDelivery = require('../models/WebhookDelivery');
const WebhookSubscription = require('../models/WebhookSubscription');
const Notification = require('../models/Notification');
const queue = require('../jobs/queue');
const safeWebhook = require('../utils/safeWebhook');
const webhooks = require('../services/outboundWebhookService');
const engine = require('../services/automation/engine');
const leadRouting = require('../services/leadRoutingService');
const { api, bearer, login } = require('./helpers/api');

const settle = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};
const dueNow = (name) => mongoose.model('Job').updateMany({ name, status: 'queued' }, { $set: { runAt: new Date() } });

describe('Outbound webhooks (Phase 10C)', () => {
  let owner;
  let calls = [];
  let answer = 200;
  beforeAll(async () => {
    safeWebhook.setLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
    engine.register(queue);
    leadRouting.attach(queue);
    webhooks.register(queue);
    jest.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      if (String(url).startsWith('https://hooks.example.com/')) {
        calls.push({ url: String(url), headers: options.headers, body: options.body });
        return new Response(answer === 200 ? 'ok' : 'nope', { status: answer });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    owner = await login('hook-owner@example.com', { name: 'Asha' });
  });
  afterAll(() => {
    jest.restoreAllMocks();
    safeWebhook.setLookup((hostname) => require('dns').promises.lookup(hostname, { all: true, verbatim: true }));
  });

  it('adds only public https addresses and shows the secret once', async () => {
    const add = (body) => api().post('/api/v1/outbound-webhooks').set(bearer(owner.token)).send(body);
    expect((await add({ url: 'http://hooks.example.com/x', events: ['lead.created'] })).body.code).toBe('WEBHOOK_URL');
    safeWebhook.setLookup(async () => [{ address: '10.0.0.5', family: 4 }]);
    expect((await add({ url: 'https://intranet.example.com/x', events: ['lead.created'] })).body.message).toBe('Webhooks cannot go to a private or local network address.');
    safeWebhook.setLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
    expect((await add({ url: 'https://hooks.example.com/x', events: ['nothing.happened'] })).status).toBe(400);
    const made = await add({ url: 'https://hooks.example.com/leads', events: ['lead.created', 'contact.created', 'lead.stage_changed'], description: 'Our ERP' });
    expect(made.status).toBe(201);
    expect(made.body.data.secret).toMatch(/^whsec_/);
    const listed = (await api().get('/api/v1/outbound-webhooks').set(bearer(owner.token))).body.data;
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].secret).toBeUndefined();
    expect(listed.events.map((e) => e.event)).toContain('payment.received');
  });

  it('sends signed events, retries a failure and keeps a delivery log', async () => {
    const sub = await WebhookSubscription.findOne({ url: 'https://hooks.example.com/leads' });
    const { secret } = (await api().post(`/api/v1/outbound-webhooks/${sub._id}/rotate-secret`).set(bearer(owner.token))).body.data;
    calls = [];
    answer = 500;
    const lead = (await api().post('/api/v1/leads').set(bearer(owner.token)).send({ title: 'Jeera 10 bags', contact: { name: 'Ravi Traders', phone: '9829011111' } })).body.data;
    await settle();
    // lead.created and contact.created, both refused once; tried again a minute later.
    expect(calls.map((c) => c.headers['X-CRM-Event']).sort()).toEqual(['contact.created', 'lead.created']);
    let log = (await api().get(`/api/v1/outbound-webhooks/${sub._id}/deliveries`).set(bearer(owner.token))).body.data;
    expect(log.every((d) => d.status === 'pending' && d.attempts === 1 && d.responseCode === 500)).toBe(true);
    const wait = new Date(log[0].nextAttemptAt) - Date.now();
    expect(wait).toBeGreaterThan(50000);
    expect(wait).toBeLessThan(61000);

    answer = 200;
    calls = [];
    await dueNow(webhooks.JOBS.DELIVER);
    await settle();
    expect(calls).toHaveLength(2);
    const leadCall = calls.find((c) => c.headers['X-CRM-Event'] === 'lead.created');
    const body = JSON.parse(leadCall.body);
    expect(body).toMatchObject({ type: 'lead.created', id: expect.stringMatching(/^evt_/), data: { lead: { id: lead.id, title: 'Jeera 10 bags', stage: 'New', contact: { name: 'Ravi Traders', phone: '+919829011111' } } } });
    expect(leadCall.headers['X-CRM-Event-Id']).toBe(body.id);
    expect(leadCall.headers['X-CRM-Signature']).toBe(`sha256=${crypto.createHmac('sha256', secret).update(leadCall.body).digest('hex')}`);
    log = (await api().get(`/api/v1/outbound-webhooks/${sub._id}/deliveries?status=delivered`).set(bearer(owner.token))).body.data;
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ attempts: 2, responseCode: 200 });

    // A stage change carries from and to.
    calls = [];
    await api().post(`/api/v1/leads/${lead.id}/stage`).set(bearer(owner.token)).send({ stage: 'Contacted' });
    await settle();
    expect(JSON.parse(calls[0].body)).toMatchObject({ type: 'lead.stage_changed', data: { from: 'New', to: 'Contacted', lead: { stage: 'Contacted' } } });
  }, 60000);

  it('pings on request, and switches an address off after many failures in a row', async () => {
    const sub = await WebhookSubscription.findOne({ url: 'https://hooks.example.com/leads' });
    answer = 200;
    const ping = (await api().post(`/api/v1/outbound-webhooks/${sub._id}/test`).set(bearer(owner.token))).body.data;
    expect(ping).toMatchObject({ event: 'ping', status: 'delivered', responseCode: 200, responseBody: 'ok' });

    answer = 503;
    await WebhookSubscription.updateOne({ _id: sub._id }, { $set: { failuresInARow: webhooks.DISABLE_AFTER_FAILURES - 1 } });
    const failed = (await api().post(`/api/v1/outbound-webhooks/${sub._id}/test`).set(bearer(owner.token))).body.data;
    expect(failed).toMatchObject({ status: 'failed', responseCode: 503 });
    const off = await WebhookSubscription.findById(sub._id);
    expect(off).toMatchObject({ active: false, disabledReason: expect.stringContaining('25 failed deliveries in a row') });
    expect(await Notification.exists({ title: 'A webhook was switched off' })).toBeTruthy();
    // Switched off: no deliveries; switched on again: works.
    calls = [];
    await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Quiet', phone: '9829044444' });
    await settle();
    expect(calls).toHaveLength(0);
    answer = 200;
    await api().patch(`/api/v1/outbound-webhooks/${sub._id}`).set(bearer(owner.token)).send({ active: true });
    expect(await WebhookSubscription.findById(sub._id)).toMatchObject({ active: true, failuresInARow: 0, disabledReason: '' });
    await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Heard', phone: '9829055555' });
    await settle();
    expect(calls.map((c) => JSON.parse(c.body).data.contact.name)).toEqual(['Heard']);
  }, 60000);

  it('sends nothing without the API in the plan, and stays in its company', async () => {
    const org = await Organization.findById(owner.data.organizationId);
    await Organization.updateOne({ _id: org._id }, { $set: { plan: 'starter', subscription: { status: 'active' } } });
    calls = [];
    await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Unsent', phone: '9829066666' });
    await settle();
    expect(calls).toHaveLength(0);
    expect((await api().post('/api/v1/outbound-webhooks').set(bearer(owner.token)).send({ url: 'https://hooks.example.com/y', events: ['lead.created'] })).body.code).toBe('PLAN_LIMIT');
    await Organization.updateOne({ _id: org._id }, { $set: { plan: 'growth' } });

    const stranger = await login('hook-stranger@example.com');
    const sub = await WebhookSubscription.findOne({ organizationId: org._id });
    expect((await api().get(`/api/v1/outbound-webhooks/${sub._id}/deliveries`).set(bearer(stranger.token))).status).toBe(404);
    expect((await api().get('/api/v1/outbound-webhooks').set(bearer(stranger.token))).body.data.items).toEqual([]);
    expect(await WebhookDelivery.countDocuments({ organizationId: { $ne: org._id } })).toBe(0);
  }, 60000);
});
