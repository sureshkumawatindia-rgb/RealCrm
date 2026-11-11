jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const ApiKey = require('../models/ApiKey');
const AuditLog = require('../models/AuditLog');
const LeadSourceConnection = require('../models/LeadSourceConnection');
const WebhookSubscription = require('../models/WebhookSubscription');
const queue = require('../jobs/queue');
const safeWebhook = require('../utils/safeWebhook');
const webhooks = require('../services/outboundWebhookService');
const { WEBHOOK_EVENT_KEYS } = require('../constants/api');
const { api, bearer, loginWithApi: login, inviteAndJoin } = require('./helpers/api'); // companies on Scale: the API needs it (D125)

// Phase 1F (D78): new webhook events, the signature with time, the 24-hour secret overlap and
// Settings → Connections.
const settle = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};
const as = (user) => ({
  get: (url) => api().get(`/api/v1${url}`).set(bearer(user.token)),
  post: (url, body) => api().post(`/api/v1${url}`).set(bearer(user.token)).send(body),
  patch: (url, body) => api().patch(`/api/v1${url}`).set(bearer(user.token)).send(body),
  del: (url) => api().delete(`/api/v1${url}`).set(bearer(user.token)),
});

// The check docs/INTEGRATIONS.md gives receivers: the time is fresh and one v1 matches.
function verify(headers, body, secret, { now = Date.now(), toleranceSeconds = 300 } = {}) {
  const parts = String(headers['X-CRM-Signature-256'] || '').split(',');
  const t = Number(parts.find((p) => p.startsWith('t='))?.slice(2));
  if (!t || Math.abs(now / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return parts.filter((p) => p.startsWith('v1=')).some((p) => crypto.timingSafeEqual(Buffer.from(p.slice(3)), Buffer.from(expected)));
}

describe('Integration and webhook registry (D78)', () => {
  let owner;
  let agent;
  let other;
  let calls = [];
  const seen = {}; // the last real payload of each event, kept across tests
  let sub;
  let secret;
  let machines;
  const take = (event) => calls.filter((c) => c.headers['X-CRM-Event'] === event).map((c) => ({ ...c, json: JSON.parse(c.body) }));

  beforeAll(async () => {
    safeWebhook.setLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
    webhooks.register(queue);
    jest.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      if (String(url).startsWith('https://hooks.example.com/')) {
        calls.push({ url: String(url), headers: options.headers, body: options.body });
        seen[options.headers['X-CRM-Event']] = JSON.parse(options.body).data;
        return new Response('ok', { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    owner = await login('ir-owner@example.com', { name: 'Asha' });
    agent = await inviteAndJoin(owner.token, 'ir-agent@example.com', { role: 'agent' });
    other = await login('ir-other@example.com');
    const made = await as(owner).post('/outbound-webhooks', {
      url: 'https://hooks.example.com/erp',
      events: ['record.created', 'record.updated', 'record.deleted', 'contact.updated', 'quotation.approval_requested', 'quotation.approval_decided'],
    });
    ({ secret } = made.body.data);
    sub = made.body.data;
    machines = (await as(owner).post('/custom-objects', { singular: 'Machine', plural: 'Machines' })).body.data;
    await as(owner).post('/custom-fields', { object: machines.key, label: 'Serial number', type: 'text' });
  });
  afterAll(() => {
    jest.restoreAllMocks();
    safeWebhook.setLookup((hostname) => require('dns').promises.lookup(hostname, { all: true, verbatim: true }));
  });

  describe('New events', () => {
    let record;

    it('a new record goes out whole, signed with the time', async () => {
      calls = [];
      record = (await as(owner).post('/records', { object: machines.key, name: 'CNC-200', customFields: { serial_number: 'SN-1' } })).body.data;
      await settle();
      const [created] = take('record.created');
      expect(created.json).toMatchObject({ type: 'record.created', data: { record: { id: record.id, object: machines.key, name: 'CNC-200', customFields: { serial_number: 'SN-1' } } } });
      expect(Math.abs(Number(created.headers['X-CRM-Timestamp']) - Date.now() / 1000)).toBeLessThan(10);
      expect(created.headers['X-CRM-Signature-256']).toMatch(/^t=\d{10},v1=[a-f0-9]{64}$/);
      expect(verify(created.headers, created.body, secret)).toBe(true);
      // The old header still works for receivers built before.
      expect(created.headers['X-CRM-Signature']).toBe(`sha256=${crypto.createHmac('sha256', secret).update(created.body).digest('hex')}`);
    });

    it('a replayed message is refused by the documented check', async () => {
      const [created] = take('record.created');
      expect(verify(created.headers, created.body, secret, { now: Date.now() + 6 * 60 * 1000 })).toBe(false);
      expect(verify(created.headers, created.body.replace('CNC-200', 'CNC-999'), secret)).toBe(false);
      expect(verify(created.headers, created.body, 'whsec_wrong')).toBe(false);
    });

    it('a record change is sent only when something changed; a delete says which one', async () => {
      calls = [];
      await as(owner).patch(`/records/${record.id}`, { name: 'CNC-200' });
      await settle();
      expect(take('record.updated')).toHaveLength(0);
      await as(owner).patch(`/records/${record.id}`, { customFields: { serial_number: 'SN-2' } });
      await settle();
      expect(take('record.updated').map((c) => c.json.data.record.customFields)).toEqual([{ serial_number: 'SN-2' }]);
      await as(owner).del(`/records/${record.id}`);
      await settle();
      expect(take('record.deleted')[0].json.data).toEqual({ record: { id: record.id, object: machines.key, name: 'CNC-200' } });
    });

    it('a customer change is sent once, and not when nothing changed', async () => {
      const customer = (await as(owner).post('/contacts', { name: 'Kota Stone', phone: '98290 72000', lifecycle: 'customer', city: 'Kota' })).body.data;
      calls = [];
      await as(owner).patch(`/contacts/${customer.id}`, { city: 'Kota' });
      await settle();
      expect(take('contact.updated')).toHaveLength(0);
      await as(owner).patch(`/contacts/${customer.id}`, { city: 'Bundi' });
      await settle();
      expect(take('contact.updated').map((c) => c.json.data.contact.city)).toEqual(['Bundi']);
    });

    it('quotation approvals are sent when asked and when decided', async () => {
      await as(owner).post('/approval-rules', { name: 'Dealer discount', discountPercentAbove: 10 });
      const customer = (await as(agent).post('/contacts', { name: 'Ajmer Agro', phone: '98290 72001', lifecycle: 'customer' })).body.data;
      const quotation = (await as(agent).post('/quotations', { contactId: customer.id, items: [{ name: 'Pump', quantity: 1, unitPricePaise: 1000000, discountType: 'percent', discountValue: 20, gstRatePct: 18 }] })).body.data;
      calls = [];
      await as(agent).post(`/quotations/${quotation.id}/approval`);
      await as(owner).post(`/quotations/${quotation.id}/approval/decision`, { decision: 'approve' });
      await settle();
      const [asked] = take('quotation.approval_requested');
      expect(asked.json.data).toMatchObject({ quotation: { id: quotation.id }, approval: { state: 'pending', reasons: [{ kind: 'discount', value: 20, limit: 10, ruleName: 'Dealer discount' }] } });
      const [decided] = take('quotation.approval_decided');
      expect(decided.json.data.approval).toMatchObject({ state: 'approved', decidedById: expect.any(String) });
    });

    it('every event has an example with the same keys as the real one', async () => {
      const { events } = (await as(owner).get('/outbound-webhooks')).body.data;
      expect(events.map((e) => e.event)).toEqual(WEBHOOK_EVENT_KEYS);
      expect(events.every((e) => e.example && Object.keys(e.example).length)).toBe(true);
      const byEvent = Object.fromEntries(events.map((e) => [e.event, e.example]));
      const real = (event) => seen[event];
      expect(Object.keys(byEvent['contact.updated'].contact).sort()).toEqual(Object.keys(real('contact.updated').contact).sort());
      expect(Object.keys(byEvent['quotation.approval_decided'].approval).sort()).toEqual(Object.keys(real('quotation.approval_decided').approval).sort());
      expect(Object.keys(byEvent['quotation.approval_decided'].quotation).sort()).toEqual(Object.keys(real('quotation.approval_decided').quotation).sort());
    });
  });

  describe('New secret with an overlap', () => {
    const recordNamed = async (name) => {
      calls = [];
      await as(owner).post('/records', { object: machines.key, name });
      await settle();
      return take('record.created')[0];
    };

    it('the old secret keeps working for 24 hours, then only the new one', async () => {
      const rotated = (await as(owner).post(`/outbound-webhooks/${sub.id}/rotate-secret`)).body.data;
      expect(new Date(rotated.overlapUntil) - Date.now()).toBeGreaterThan(23.9 * 3600e3);
      const during = await recordNamed('During');
      expect(during.headers['X-CRM-Signature-256'].split(',').filter((p) => p.startsWith('v1='))).toHaveLength(2);
      expect(verify(during.headers, during.body, rotated.secret)).toBe(true);
      expect(verify(during.headers, during.body, secret)).toBe(true);
      expect(during.headers['X-CRM-Signature']).toBe(`sha256=${crypto.createHmac('sha256', rotated.secret).update(during.body).digest('hex')}`);

      // Once the overlap has passed, the old secret is not used.
      await WebhookSubscription.updateOne({ _id: sub.id }, { $set: { previousSecretUntil: new Date(Date.now() - 1000) } });
      const after = await recordNamed('After');
      expect(verify(after.headers, after.body, rotated.secret)).toBe(true);
      expect(verify(after.headers, after.body, secret)).toBe(false);
      secret = rotated.secret;
    });

    it('"End the overlap now" and a rotation without overlap stop the old secret at once', async () => {
      const rotated = (await as(owner).post(`/outbound-webhooks/${sub.id}/rotate-secret`, { overlapHours: 24 })).body.data;
      const ended = (await as(owner).post(`/outbound-webhooks/${sub.id}/end-overlap`)).body.data;
      expect(ended.overlapUntil).toBeNull();
      const one = await recordNamed('Ended');
      expect(verify(one.headers, one.body, rotated.secret)).toBe(true);
      expect(verify(one.headers, one.body, secret)).toBe(false);
      const atOnce = (await as(owner).post(`/outbound-webhooks/${sub.id}/rotate-secret`, { overlapHours: 0 })).body.data;
      expect(atOnce.overlapUntil).toBeNull();
      const two = await recordNamed('At once');
      expect(verify(two.headers, two.body, atOnce.secret)).toBe(true);
      expect(verify(two.headers, two.body, rotated.secret)).toBe(false);
      expect((await as(owner).post(`/outbound-webhooks/${sub.id}/rotate-secret`, { overlapHours: 5 })).status).toBe(400);
      expect((await as(agent).post(`/outbound-webhooks/${sub.id}/end-overlap`)).status).toBe(403);
      expect((await as(other).post(`/outbound-webhooks/${sub.id}/end-overlap`)).status).toBe(404);
      expect(await AuditLog.exists({ action: 'webhook.overlap_ended' })).toBeTruthy();
    });
  });

  describe('Settings → Connections', () => {
    const states = (data) => Object.fromEntries(data.items.map((i) => [`${i.kind}:${i.name}`, i.state]));

    it('shows every kind, what works and what needs attention; owners and admins only', async () => {
      expect((await as(agent).get('/integrations/status')).status).toBe(403);
      const fresh = (await as(other).get('/integrations/status')).body.data;
      expect(fresh.items.map((i) => i.kind)).toEqual(['whatsapp', 'gmail', 'payments', 'leadsources', 'metaCapi', 'apiKeys', 'webhooks', 'microsoft', 'teams', 'calling', 'sms', 'sheets']); // Microsoft 365 and Teams since D83, calling D85, SMS D88, Google Sheets D108
      expect(fresh.items.every((i) => i.state === 'not_connected')).toBe(true);
      expect(fresh.needsAttention).toBe(0);

      await as(owner).post('/whatsapp/accounts', { provider: 'mock', name: 'Shop' });
      await as(owner).post('/api-keys', { name: 'ERP', scopes: ['records:read'] });
      const { organizationId } = await ApiKey.findOne({ name: 'ERP' });
      await LeadSourceConnection.create({ organizationId, type: 'indiamart', name: 'IndiaMART main', status: 'error', statusMessage: 'The IndiaMART key was refused.' });
      await WebhookSubscription.updateOne({ _id: sub.id }, { $set: { lastStatus: 'failed', lastResponseCode: 502 } });

      const data = (await as(owner).get('/integrations/status')).body.data;
      const by = states(data);
      expect(by['apiKeys:1 key']).toBe('working');
      expect(by['leadsources:IndiaMART main']).toBe('attention');
      expect(by['webhooks:https://hooks.example.com/erp']).toBe('attention');
      expect(by['gmail:']).toBe('not_connected');
      expect(data.items.find((i) => i.kind === 'whatsapp').state).not.toBe('not_connected');
      expect(data.items.find((i) => i.kind === 'leadsources').problem).toBe('The IndiaMART key was refused.');
      expect(data.items.find((i) => i.kind === 'webhooks').problem).toMatch(/502/);
      expect(data.items.find((i) => i.kind === 'leadsources').settingsTab).toBe('leadsources');
      expect(data.needsAttention).toBe(data.items.filter((i) => i.state === 'attention').length);
      // Another company still sees only its own.
      expect((await as(other).get('/integrations/status')).body.data.items.every((i) => i.state === 'not_connected')).toBe(true);
    });
  });
});
