jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Lead = require('../models/Lead');
const ApiKey = require('../models/ApiKey');
const Message = require('../models/Message');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const pub = (key) => ({ get: (path) => api().get(`/api/public/v1${path}`).set('Authorization', `Bearer ${key}`), post: (path, body) => api().post(`/api/public/v1${path}`).set('Authorization', `Bearer ${key}`).send(body), patch: (path, body) => api().patch(`/api/public/v1${path}`).set('Authorization', `Bearer ${key}`).send(body) });

describe('Public API (Phase 10C)', () => {
  let owner;
  let agent;
  let full;
  let readOnly;
  beforeAll(async () => {
    owner = await login('api-owner@example.com', { name: 'Asha' });
    agent = await inviteAndJoin(owner.token, 'api-agent@example.com', { role: 'agent' });
    await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token)).send({ provider: 'mock' });
  });

  it('makes keys for owners and admins only, shows the key once and keeps only its hash', async () => {
    expect((await api().post('/api/v1/api-keys').set(bearer(agent.token)).send({ name: 'Zapier', scopes: ['contacts:read'] })).status).toBe(403);
    expect((await api().post('/api/v1/api-keys').set(bearer(owner.token)).send({ name: 'Zapier', scopes: ['everything'] })).status).toBe(400);
    const made = await api().post('/api/v1/api-keys').set(bearer(owner.token)).send({ name: 'Zapier', scopes: ['contacts:read', 'contacts:write', 'leads:read', 'leads:write', 'quotations:read', 'orders:read', 'products:read', 'messages:write'] });
    expect(made.status).toBe(201);
    full = made.body.data.key;
    expect(full).toMatch(/^ycrm_[a-f0-9]{10}_[A-Za-z0-9_-]{32}$/);
    readOnly = (await api().post('/api/v1/api-keys').set(bearer(owner.token)).send({ name: 'Reports', scopes: ['contacts:read'] })).body.data.key;
    const listed = (await api().get('/api/v1/api-keys').set(bearer(owner.token))).body.data;
    expect(listed.items.map((k) => k.name)).toEqual(['Reports', 'Zapier']);
    expect(JSON.stringify(listed)).not.toContain(full.split('_')[2]);
    expect(listed.items[1]).toMatchObject({ preview: `${full.split('_').slice(0, 2).join('_')}_…`, createdBy: 'Asha' });
    expect(listed.scopes).toHaveLength(8);
    const stored = await ApiKey.findOne({ name: 'Zapier' });
    expect(stored.hash).toHaveLength(64);
    expect(JSON.stringify(stored.toObject())).not.toContain(full.split('_')[2]);
  });

  it('refuses missing, wrong and short-scoped keys', async () => {
    expect((await api().get('/api/public/v1/me')).body.code).toBe('API_KEY_INVALID');
    expect((await pub('ycrm_0000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').get('/me')).status).toBe(401);
    expect((await pub(`${full.slice(0, -1)}${full.endsWith('A') ? 'B' : 'A'}`).get('/me')).status).toBe(401);
    expect((await pub(owner.token).get('/me')).status).toBe(401); // a sign-in token is not an API key
    const me = (await api().get('/api/public/v1/me').set('X-API-Key', readOnly)).body.data;
    expect(me).toMatchObject({ organization: { name: expect.any(String) }, key: { name: 'Reports', scopes: [{ scope: 'contacts:read', label: 'Read customers' }] } });
    const refused = await pub(readOnly).post('/contacts', { name: 'X' });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'SCOPE_MISSING', message: 'This API key cannot do this: it needs the "contacts:write" scope.' });
  });

  it('adds, finds, changes and polls customers', async () => {
    const created = await pub(full).post('/contacts', { name: 'Ravi Traders', phone: '98290 11111', email: 'ravi@example.com', city: 'Jaipur', tags: ['tier-a'] });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'Ravi Traders', phone: '+919829011111', source: 'API', tags: ['tier-a'], marketingConsent: 'unknown' });
    expect((await pub(full).post('/contacts', { name: 'Again', phone: '9829011111' })).status).toBe(409);
    const since = new Date().toISOString();
    await pub(full).patch(`/contacts/${created.body.data.id}`, { company: 'Ravi Traders Pvt Ltd' });
    const found = await pub(readOnly).get('/contacts?phone=9829011111');
    expect(found.body.data.map((c) => c.company)).toEqual(['Ravi Traders Pvt Ltd']);
    expect(found.body.pagination).toMatchObject({ page: 1, total: 1 });
    expect((await pub(readOnly).get(`/contacts?updatedSince=${encodeURIComponent(since)}`)).body.data.map((c) => c.name)).toEqual(['Ravi Traders']);
    expect((await pub(readOnly).get('/contacts?limit=500')).status).toBe(400);
    // Another company's records are not found.
    const stranger = await login('api-stranger@example.com');
    const theirs = (await api().post('/api/v1/contacts').set(bearer(stranger.token)).send({ name: 'Theirs' })).body.data;
    expect((await pub(full).get(`/contacts/${theirs.id}`)).status).toBe(404);
  });

  it('takes leads like a lead source: new, repeat, attached; then moves the stage', async () => {
    const lead = await pub(full).post('/leads', { contact: { name: 'Kiran Stores', phone: '9829022222' }, product: 'Jeera 25kg', quantity: 10, message: 'Need a rate', externalId: 'form-1' });
    expect(lead.status).toBe(201);
    expect(lead.body.data).toMatchObject({ outcome: 'created', lead: { title: 'Jeera 25kg', stage: 'New', source: 'API', contact: { name: 'Kiran Stores', phone: '+919829022222' } } });
    const again = await pub(full).post('/leads', { contact: { name: 'Kiran Stores', phone: '9829022222' }, product: 'Jeera 25kg', externalId: 'form-1' });
    expect(again.status).toBe(200);
    expect(again.body.data.outcome).toBe('duplicate');
    expect((await pub(full).post('/leads', { contact: { phone: '9829022222' }, message: 'Also haldi' })).body.data).toMatchObject({ outcome: 'attached', lead: { id: lead.body.data.lead.id } });
    expect((await pub(full).post('/leads', { contact: { name: 'Nobody' } })).body.code).toBe('VALIDATION_ERROR');
    const won = await pub(full).post(`/leads/${lead.body.data.lead.id}/stage`, { stage: 'Won' });
    expect(won.body.data).toMatchObject({ stage: 'Won' });
    expect((await pub(full).get('/leads?stage=Won')).body.data).toHaveLength(1);
    expect((await Lead.findById(lead.body.data.lead.id)).source).toBe('API');
  });

  it('sends an approved template and lists products, quotations and orders', async () => {
    await api().post('/api/v1/templates/sync').set(bearer(owner.token)).send({});
    const sent = await pub(full).post('/messages', { phone: '9829033333', name: 'Bela', template: { name: 'hello_world' } });
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ contactId: expect.any(String), conversationId: expect.any(String) });
    expect(await Message.findOne({ 'automation.kind': 'api' })).toMatchObject({ type: 'template', direction: 'out' });
    expect((await pub(full).post('/messages', { phone: '9829033333', template: { name: 'diwali_offer' } })).body.code).toBe('TEMPLATE_NOT_SENDABLE');
    expect((await pub(full).post('/messages', { phone: '9829033333', template: { name: 'nope' } })).body.code).toBe('TEMPLATE_NOT_FOUND');
    expect((await pub(full).post('/messages', { template: { name: 'hello_world' } })).status).toBe(400);
    await api().post('/api/v1/products').set(bearer(owner.token)).send({ name: 'Jeera 25kg', pricePaise: 300000, gstRatePct: 5 });
    expect((await pub(full).get('/products')).body.data).toMatchObject([{ name: 'Jeera 25kg', pricePaise: 300000, gstRatePct: 5 }]);
    expect((await pub(full).get('/quotations')).body).toMatchObject({ data: [], pagination: { total: 0 } });
    expect((await pub(full).get('/orders')).body.data).toEqual([]);
  });

  it('stops when the plan has no API, the key is revoked or its maker leaves', async () => {
    const org = await Organization.findOne({ ownerId: (await OrganizationMember.findById(owner.data.member.id)).userId });
    await Organization.updateOne({ _id: org._id }, { $set: { plan: 'pro', subscription: { status: 'active' } } });
    const blocked = await pub(full).get('/me');
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: 'PLAN_LIMIT', message: expect.stringContaining('The public API and webhooks come with the Growth plan') });
    expect((await api().post('/api/v1/api-keys').set(bearer(owner.token)).send({ name: 'More', scopes: ['contacts:read'] })).body.code).toBe('PLAN_LIMIT');
    await Organization.updateOne({ _id: org._id }, { $set: { plan: 'growth' } });
    expect((await pub(full).get('/me')).status).toBe(200);

    // A key made by an admin stops when the admin is no longer one.
    const admin = await inviteAndJoin(owner.token, 'api-admin@example.com', { role: 'admin' });
    const adminKey = (await api().post('/api/v1/api-keys').set(bearer(admin.token)).send({ name: 'Admin key', scopes: ['contacts:read'] })).body.data.key;
    expect((await pub(adminKey).get('/me')).status).toBe(200);
    await api().patch(`/api/v1/members/${admin.data.member.id}`).set(bearer(owner.token)).send({ role: 'agent' });
    expect((await pub(adminKey).get('/me')).body.message).toBe('The person who made this API key is no longer an owner or admin of the company; make a new key.');

    const keys = (await api().get('/api/v1/api-keys').set(bearer(owner.token))).body.data.items;
    const reports = keys.find((k) => k.name === 'Reports');
    expect((await api().delete(`/api/v1/api-keys/${reports.id}`).set(bearer(owner.token))).body.data.revokedAt).toBeTruthy();
    expect((await pub(readOnly).get('/me')).status).toBe(401);
  });
});
