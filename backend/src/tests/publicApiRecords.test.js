jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const AuditLog = require('../models/AuditLog');
const { api, bearer, login } = require('./helpers/api');

// Phase 1F (D78): the company's own objects and their records in the public API.
const pub = (key) => ({
  get: (path) => api().get(`/api/public/v1${path}`).set('Authorization', `Bearer ${key}`),
  post: (path, body) => api().post(`/api/public/v1${path}`).set('Authorization', `Bearer ${key}`).send(body),
  patch: (path, body) => api().patch(`/api/public/v1${path}`).set('Authorization', `Bearer ${key}`).send(body),
});
const as = (user) => ({
  get: (url) => api().get(`/api/v1${url}`).set(bearer(user.token)),
  post: (url, body) => api().post(`/api/v1${url}`).set(bearer(user.token)).send(body),
});
const codes = (res) => Object.fromEntries((res.body.errors || []).map((e) => [e.field, e.code]));
const keyFor = async (user, scopes) => (await as(user).post('/api-keys', { name: scopes.join(' '), scopes })).body.data.key;

describe('Public API: records of your own objects (D78)', () => {
  let owner;
  let other;
  let full;
  let readOnly;
  let contactsOnly;
  let theirs;
  let machines;
  let customer;
  let record;

  beforeAll(async () => {
    owner = await login('pr-owner@example.com', { name: 'Asha' });
    other = await login('pr-other@example.com');
    machines = (await as(owner).post('/custom-objects', { singular: 'Machine', plural: 'Machines' })).body.data;
    const field = (body) => as(owner).post('/custom-fields', { object: machines.key, ...body });
    await field({ label: 'Serial number', type: 'text' });
    await field({ label: 'AMC type', type: 'dropdown', options: [{ label: 'Comprehensive' }, { label: 'Labour only' }] });
    await field({ label: 'Model', type: 'text', required: true });
    await field({ label: 'Installed for', type: 'lookup', lookupTarget: 'contact' });
    customer = (await as(owner).post('/contacts', { name: 'Kota Stone Works', phone: '98290 71000', lifecycle: 'customer' })).body.data;
    full = await keyFor(owner, ['records:read', 'records:write']);
    readOnly = await keyFor(owner, ['records:read']);
    contactsOnly = await keyFor(owner, ['contacts:read']);
    theirs = await keyFor(other, ['records:read', 'records:write']);
  });

  it('lists the objects with their fields, for keys with records:read', async () => {
    const res = await pub(readOnly).get('/objects');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({ key: machines.key, singular: 'Machine', plural: 'Machines' })]);
    const fields = res.body.data[0].fields;
    expect(fields.map((f) => f.key)).toEqual(['serial_number', 'amc_type', 'model', 'installed_for']);
    expect(fields[1].options.map((o) => o.label)).toEqual(['Comprehensive', 'Labour only']);
    expect(fields[3]).toMatchObject({ type: 'lookup', lookupTarget: 'contact' });
    expect((await pub(contactsOnly).get('/objects')).status).toBe(403);
    expect((await pub(theirs).get('/objects')).body.data).toEqual([]);
  });

  it('adds records with checked values; a required field never stops the API', async () => {
    const res = await pub(full).post('/records', {
      object: machines.key, name: 'CNC-200 main', contactId: customer.id,
      customFields: { serial_number: 'SN-4471', amc_type: 'Comprehensive', installed_for: customer.id },
    });
    expect(res.status).toBe(201);
    record = res.body.data;
    expect(record).toMatchObject({
      object: machines.key, name: 'CNC-200 main', contactId: customer.id,
      customFields: { serial_number: 'SN-4471', amc_type: 'Comprehensive', installed_for: customer.id },
    });
    expect((await pub(readOnly).post('/records', { object: machines.key, name: 'X' })).status).toBe(403);
    expect(codes(await pub(full).post('/records', { object: machines.key, name: 'Bad', customFields: { amc_type: 'Gold' } }))).toEqual({ 'customFields.amc_type': 'INVALID_OPTION' });
    expect(codes(await pub(full).post('/records', { object: machines.key, name: 'Bad', customFields: { colour: 'red' } }))).toEqual({ 'customFields.colour': 'UNKNOWN_FIELD' });
    expect((await pub(full).post('/records', { object: 'x_nothing', name: 'Bad' })).status).toBe(404);
    expect((await pub(full).post('/records', { object: 'contact', name: 'Bad' })).status).toBe(400);
    expect(await AuditLog.exists({ action: 'record.created', entityId: record.id })).toBeTruthy();
  });

  it('links stay inside the company', async () => {
    const theirCustomer = (await as(other).post('/contacts', { name: 'Elsewhere', phone: '98290 71099', lifecycle: 'customer' })).body.data;
    expect(codes(await pub(full).post('/records', { object: machines.key, name: 'Bad', contactId: theirCustomer.id }))).toEqual({ contactId: 'INVALID_LINK' });
    expect(codes(await pub(full).post('/records', { object: machines.key, name: 'Bad', customFields: { installed_for: theirCustomer.id } }))).toEqual({ 'customFields.installed_for': 'INVALID_LINK' });
  });

  it('reads, searches, filters and changes records', async () => {
    await pub(full).post('/records', { object: machines.key, name: 'Lathe 9', customFields: { serial_number: 'LT-0009', model: 'L9' } });
    const all = await pub(readOnly).get(`/records?object=${machines.key}`);
    expect(all.body.data.map((r) => r.name)).toEqual(['Lathe 9', 'CNC-200 main']);
    expect(all.body.pagination).toMatchObject({ total: 2 });
    expect((await pub(readOnly).get(`/records?object=${machines.key}&search=SN-4471`)).body.data.map((r) => r.name)).toEqual(['CNC-200 main']);
    expect((await pub(readOnly).get(`/records?object=${machines.key}&cf=serial_number:is:LT-0009`)).body.data.map((r) => r.name)).toEqual(['Lathe 9']);
    expect((await pub(readOnly).get('/records')).status).toBe(400);
    expect((await pub(readOnly).get(`/records/${record.id}`)).body.data.name).toBe('CNC-200 main');
    const changed = await pub(full).patch(`/records/${record.id}`, { name: 'CNC-200 (main)', customFields: { amc_type: 'Labour only' } });
    expect(changed.body.data).toMatchObject({ name: 'CNC-200 (main)', customFields: { serial_number: 'SN-4471', amc_type: 'Labour only' } });
    expect((await pub(full).patch(`/records/${record.id}`, { object: 'x_other' })).status).toBe(400);
    expect((await pub(readOnly).patch(`/records/${record.id}`, { name: 'No' })).status).toBe(403);
  });

  it('never shows another company’s records, nor those of an archived object', async () => {
    expect((await pub(theirs).get(`/records/${record.id}`)).status).toBe(404);
    expect((await pub(theirs).patch(`/records/${record.id}`, { name: 'Mine' })).status).toBe(404);
    expect((await pub(theirs).get(`/records?object=${machines.key}`)).status).toBe(404);
    await as(owner).post(`/custom-objects/${machines.id}/archive`);
    expect((await pub(full).get(`/records?object=${machines.key}`)).status).toBe(404);
    expect((await pub(full).get(`/records/${record.id}`)).status).toBe(404);
    expect((await pub(full).post('/records', { object: machines.key, name: 'Late' })).status).toBe(404);
    expect((await pub(full).get('/objects')).body.data).toEqual([]);
    await as(owner).post(`/custom-objects/${machines.id}/restore`);
  });
});
