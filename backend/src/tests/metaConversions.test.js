jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const Organization = require('../models/Organization');
const ConversionsApiConnection = require('../models/ConversionsApiConnection');
const queue = require('../jobs/queue');
const leadIntake = require('../services/leadIntakeService');
const leadRouting = require('../services/leadRoutingService');
const engine = require('../services/automation/engine');
const metaConversions = require('../services/metaConversionsService');
const { api, bearer, login } = require('./helpers/api');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const settle = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};
const DATASET = '1234567890123';
const TOKEN = 'EAAG-capi-token-0123456789abcdef';

describe('Meta Conversions API for CRM (Phase 10C)', () => {
  let owner;
  let sent = [];
  let refuse = false;
  beforeAll(async () => {
    engine.register(queue);
    leadRouting.attach(queue);
    metaConversions.register(queue);
    jest.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const target = String(url);
      const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (target.endsWith(`/${DATASET}?fields=id,name`)) {
        return options.headers.Authorization === `Bearer ${TOKEN}` ? reply({ id: DATASET, name: 'Yellow Traders pixel' }) : reply({ error: { message: 'Invalid OAuth access token.' } }, 400);
      }
      if (target.endsWith(`/${DATASET}/events`)) {
        if (refuse) return reply({ error: { message: 'Invalid parameter', error_user_msg: 'The lead_id is not valid.' } }, 400);
        sent.push(JSON.parse(options.body));
        expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
        expect(target).not.toContain(TOKEN);
        return reply({ events_received: 1, fbtrace_id: 'trace1' });
      }
      return reply({});
    });
    owner = await login('capi-owner@example.com', { name: 'Asha' });
  });
  afterAll(() => jest.restoreAllMocks());

  const save = (body) => api().put('/api/v1/meta-conversions').set(bearer(owner.token)).send(body);

  it('connects a dataset after Meta accepts the token, and never shows the token again', async () => {
    expect((await api().get('/api/v1/meta-conversions').set(bearer(owner.token))).body.data).toMatchObject({ available: true, connected: false });
    expect((await save({ datasetId: DATASET })).body.message).toBe('Paste the access token from Meta Events Manager.');
    expect((await save({ datasetId: 'pixel-1', accessToken: TOKEN })).status).toBe(400);
    expect((await save({ datasetId: DATASET, accessToken: 'EAAG-wrong-token-000000000' })).body).toMatchObject({ code: 'META_ERROR', message: 'Meta: Invalid OAuth access token.' });
    const saved = await save({ datasetId: DATASET, accessToken: TOKEN });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ connected: true, datasetName: 'Yellow Traders pixel', accessToken: { last4: 'cdef' }, enabled: true, allSources: false, status: 'connected' });
    expect(JSON.stringify(saved.body)).not.toContain(TOKEN);
    expect((await ConversionsApiConnection.findOne()).accessTokenEnc).not.toContain(TOKEN);
  });

  it('sends Lead Ads leads and their stages with the lead id and hashed phone and email', async () => {
    sent = [];
    const org = owner.data.organizationId;
    const { leadId } = await leadIntake.intake({ organizationId: org, source: 'Facebook', sourceRef: '987654321098765', person: { name: 'Ravi', phone: '98290 11111', email: ' Ravi@Example.com ' }, enquiry: { product: 'Jeera' } });
    await settle();
    expect(sent).toHaveLength(1);
    const [event] = sent[0].data;
    expect(event).toMatchObject({
      event_name: 'New', action_source: 'system_generated',
      user_data: { lead_id: '987654321098765', em: [sha('ravi@example.com')], ph: [sha('919829011111')] },
      custom_data: { event_source: 'crm', lead_event_source: 'YELLOW CRM' },
    });
    expect(Math.abs(event.event_time - Date.now() / 1000)).toBeLessThan(60);
    expect(sent[0].test_event_code).toBeUndefined();

    await api().post(`/api/v1/leads/${leadId}/stage`).set(bearer(owner.token)).send({ stage: 'Contacted' });
    await settle();
    expect(sent.map((s) => s.data[0].event_name)).toEqual(['New', 'Contacted']);

    // Leads from other sources go only with "all sources", matched by phone and email.
    const manual = (await api().post('/api/v1/leads').set(bearer(owner.token)).send({ title: 'Walk-in', contact: { name: 'Kiran', phone: '9829022222' } })).body.data;
    await settle();
    expect(sent).toHaveLength(2);
    await save({ allSources: true, stages: ['Won'] });
    await api().post(`/api/v1/leads/${manual.id}/stage`).set(bearer(owner.token)).send({ stage: 'Contacted' });
    await api().post(`/api/v1/leads/${manual.id}/stage`).set(bearer(owner.token)).send({ stage: 'Won' });
    await settle();
    expect(sent).toHaveLength(3);
    expect(sent[2].data[0]).toMatchObject({ event_name: 'Won', user_data: { ph: [sha('919829022222')] } });
    expect(sent[2].data[0].user_data.lead_id).toBeUndefined();
    const stats = (await api().get('/api/v1/meta-conversions').set(bearer(owner.token))).body.data.stats;
    expect(stats).toMatchObject({ sent: 3, failed: 0 });
    expect(stats.skipped).toBeGreaterThanOrEqual(2);
  }, 60000);

  it('sends a test event with the test code, and records refusals', async () => {
    expect((await api().post('/api/v1/meta-conversions/test').set(bearer(owner.token))).status).toBe(400);
    await save({ testEventCode: 'TEST12345', stages: ['New', 'Contacted', 'Won'] });
    sent = [];
    const test = await api().post('/api/v1/meta-conversions/test').set(bearer(owner.token));
    expect(test.body.data).toMatchObject({ eventsReceived: 1 });
    expect(sent[0]).toMatchObject({ test_event_code: 'TEST12345', data: [{ event_name: 'New', action_source: 'system_generated' }] });

    refuse = true;
    await leadIntake.intake({ organizationId: owner.data.organizationId, source: 'Facebook', sourceRef: '111111111111111', person: { phone: '9829033333' } });
    await settle();
    refuse = false;
    const stats = (await api().get('/api/v1/meta-conversions').set(bearer(owner.token))).body.data.stats;
    expect(stats).toMatchObject({ failed: 1, lastError: 'Meta: The lead_id is not valid.' });
  }, 60000);

  it('needs the Pro plan or above, and owners or admins', async () => {
    await Organization.updateOne({ _id: owner.data.organizationId }, { $set: { plan: 'starter', subscription: { status: 'active' } } });
    expect((await save({ enabled: true })).body.code).toBe('PLAN_LIMIT');
    expect((await api().get('/api/v1/meta-conversions').set(bearer(owner.token))).body.data.available).toBe(false);
    sent = [];
    await leadIntake.intake({ organizationId: owner.data.organizationId, source: 'Facebook', sourceRef: '222222222222222', person: { phone: '9829044444' } });
    await settle();
    expect(sent).toHaveLength(0);
    const stranger = await login('capi-stranger@example.com');
    expect((await api().get('/api/v1/meta-conversions').set(bearer(stranger.token))).body.data.connected).toBe(false);
  }, 60000);
});
