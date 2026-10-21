jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 1E (D77): who may see and change each custom field. Owners and admins always may; agents
// get Edit / See only / Hidden, viewers See / Hidden. A hidden field never reaches that role.
const as = (user) => ({
  get: (url) => api().get(`/api/v1${url}`).set(bearer(user.token)),
  post: (url, body) => api().post(`/api/v1${url}`).set(bearer(user.token)).send(body),
  patch: (url, body) => api().patch(`/api/v1${url}`).set(bearer(user.token)).send(body),
});
const codes = (res) => Object.fromEntries((res.body.errors || []).map((e) => [e.field, e.code]));
const keysOf = (res) => res.body.data.map((f) => f.key);

describe('Field access per role', () => {
  let owner;
  let admin;
  let agent;
  let viewer;
  let other;
  let agentMemberId;
  let shared; // a customer the agent owns, filled in by the owner
  const field = {};

  beforeAll(async () => {
    owner = await login('fa-owner@example.com');
    admin = await inviteAndJoin(owner.token, 'fa-admin@example.com', { role: 'admin' });
    agent = await inviteAndJoin(owner.token, 'fa-agent@example.com', { role: 'agent' });
    viewer = await inviteAndJoin(owner.token, 'fa-viewer@example.com', { role: 'viewer', permissions: ['customers:view_all', 'leads:view_all'] });
    other = await login('fa-other@example.com');
    agentMemberId = agent.data.member.id;
    const add = async (body) => (await as(owner).post('/custom-fields', { object: 'contact', ...body })).body.data;
    field.price = await add({ label: 'Purchase price', type: 'number', access: { agent: 'hidden', viewer: 'hidden' } });
    field.code = await add({ label: 'Secret code', type: 'text', access: { agent: 'hidden' } });
    field.credit = await add({ label: 'Credit limit', type: 'number', access: { agent: 'view' } });
    field.notes = await add({ label: 'Visit notes', type: 'text' });
    field.ref = await add({ label: 'Referred by', type: 'lookup', lookupTarget: 'contact', access: { agent: 'hidden' } });
    const referrer = (await as(owner).post('/contacts', { name: 'Referrer Co', phone: '98290 51000', lifecycle: 'customer' })).body.data;
    shared = (await as(owner).post('/contacts', {
      name: 'Kota Stone Works', phone: '98290 51001', lifecycle: 'customer', ownerId: agentMemberId,
      customFields: { purchase_price: 41000, secret_code: 'ZX-991', credit_limit: 50000, visit_notes: 'Gate 2', referred_by: referrer.id },
    })).body.data;
  });

  it('a field starts as agents edit, viewers see; managers see every field', async () => {
    expect(field.notes.access).toEqual({ agent: 'edit', viewer: 'view' });
    expect(field.price.access).toEqual({ agent: 'hidden', viewer: 'hidden' });
    expect(field.code.access).toEqual({ agent: 'hidden', viewer: 'view' });
    const mine = await as(admin).get('/custom-fields?object=contact');
    expect(keysOf(mine)).toEqual(['purchase_price', 'secret_code', 'credit_limit', 'visit_notes', 'referred_by']);
    expect(mine.body.data.every((f) => f.canEdit)).toBe(true);
  });

  it('agents and viewers get only the fields they may see, and whether they may change them', async () => {
    const forAgent = await as(agent).get('/custom-fields?object=contact');
    expect(keysOf(forAgent)).toEqual(['credit_limit', 'visit_notes']);
    expect(Object.fromEntries(forAgent.body.data.map((f) => [f.key, f.canEdit]))).toEqual({ credit_limit: false, visit_notes: true });
    const forViewer = await as(viewer).get('/custom-fields?object=contact');
    expect(keysOf(forViewer)).toEqual(['secret_code', 'credit_limit', 'visit_notes', 'referred_by']);
    expect(forViewer.body.data.every((f) => f.canEdit === false)).toBe(true);
  });

  it('a hidden value and its link name never reach that role: get, list, Customer 360 data', async () => {
    const one = (await as(agent).get(`/contacts/${shared.id}`)).body.data;
    expect(one.customFields).toEqual({ credit_limit: 50000, visit_notes: 'Gate 2' });
    expect(one.customFieldLinks).toEqual({});
    const listed = (await as(agent).get('/contacts?lifecycle=customer')).body.data.find((c) => c.id === shared.id);
    expect(listed.customFields).toEqual({ credit_limit: 50000, visit_notes: 'Gate 2' });
    const seen = (await as(viewer).get(`/contacts/${shared.id}`)).body.data;
    expect(Object.keys(seen.customFields).sort()).toEqual(['credit_limit', 'referred_by', 'secret_code', 'visit_notes']);
    expect(seen.customFieldLinks.referred_by).toMatchObject({ name: 'Referrer Co' });
    expect((await as(owner).get(`/contacts/${shared.id}`)).body.data.customFields.purchase_price).toBe(41000);
  });

  it('nor through search or filters', async () => {
    const found = (user) => as(user).get('/contacts?lifecycle=customer&q=ZX-991');
    expect((await found(owner)).body.data.map((c) => c.name)).toEqual(['Kota Stone Works']);
    expect((await found(agent)).body.data).toEqual([]);
    const top = await as(agent).get('/search?q=ZX-991');
    expect(top.body.data.groups).toEqual([]);
    expect((await as(owner).get('/search?q=ZX-991')).body.data.groups.map((g) => g.type)).toContain('customers');
    expect((await as(agent).get('/contacts?cf=secret_code:is:ZX-991')).status).toBe(400);
    expect((await as(agent).get('/contacts?cf=purchase_price:gt:100')).status).toBe(400);
    expect((await as(owner).get('/contacts?cf=secret_code:is:ZX-991')).body.data).toHaveLength(1);
  });

  it('agents cannot change a "see only" field, nor touch a hidden one; the rest saves and nothing is lost', async () => {
    const save = (customFields) => as(agent).patch(`/contacts/${shared.id}`, { customFields });
    expect(codes(await save({ credit_limit: 99999 }))).toEqual({ 'customFields.credit_limit': 'FIELD_READ_ONLY' });
    expect(codes(await save({ secret_code: 'mine' }))).toEqual({ 'customFields.secret_code': 'UNKNOWN_FIELD' });
    // The forms send back the value they were given: that is fine.
    const ok = await save({ credit_limit: 50000, visit_notes: 'Gate 3' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.customFields).toEqual({ credit_limit: 50000, visit_notes: 'Gate 3' });
    const full = (await as(owner).get(`/contacts/${shared.id}`)).body.data.customFields;
    expect(full).toMatchObject({ purchase_price: 41000, secret_code: 'ZX-991', credit_limit: 50000, visit_notes: 'Gate 3' });
    expect((await as(admin).patch(`/contacts/${shared.id}`, { customFields: { credit_limit: 75000 } })).status).toBe(200);
  });

  it('a required field is not asked of a role that may not fill it', async () => {
    const gst = (await as(owner).post('/custom-fields', { object: 'contact', label: 'GST type', type: 'text', required: true, access: { agent: 'view' } })).body.data;
    const byAgent = await as(agent).post('/contacts', { name: 'No GST Yet', phone: '98290 51002', lifecycle: 'customer', customFields: {} });
    expect(byAgent.status).toBe(201);
    const byOwner = await as(owner).post('/contacts', { name: 'Owner Customer', phone: '98290 51003', lifecycle: 'customer', customFields: {} });
    expect(codes(byOwner)).toEqual({ 'customFields.gst_type': 'REQUIRED' });
    await as(owner).post(`/custom-fields/${gst.id}/archive`);
  });

  it('the CSV import offers agents only the fields they may change', async () => {
    const file = 'Name,Phone,Credit limit,Visit notes,Secret code\nRam,9829051010,10,Back gate,AB\n';
    const preview = (user) => api().post('/api/v1/contacts/import/preview').set(bearer(user.token)).attach('file', Buffer.from(file, 'utf8'), 'customers.csv');
    const res = await preview(agent);
    expect(res.status).toBe(200);
    expect(res.body.data.customFields.map((f) => f.value)).toEqual(['cf:visit_notes']);
    expect(res.body.data.mapping).toEqual(['name', 'phone', '', 'cf:visit_notes', '']);
    expect((await preview(owner)).body.data.customFields.map((f) => f.value)).toEqual(expect.arrayContaining(['cf:credit_limit', 'cf:secret_code', 'cf:purchase_price']));
  });

  it('works the same on leads and on records', async () => {
    const margin = (await as(owner).post('/custom-fields', { object: 'lead', label: 'Margin', type: 'number', access: { agent: 'hidden' } })).body.data;
    const lead = (await as(agent).post('/leads', { contact: { name: 'Bundi Mills', phone: '98290 51020' }, title: 'Loom order' })).body.data;
    expect((await as(owner).patch(`/leads/${lead.id}`, { customFields: { margin: 12 } })).status).toBe(200);
    expect((await as(agent).get(`/leads/${lead.id}`)).body.data.customFields).toEqual({});
    expect((await as(owner).get(`/leads/${lead.id}`)).body.data.customFields).toEqual({ margin: 12 });
    expect((await as(agent).get('/custom-fields?object=lead')).body.data.map((f) => f.key)).not.toContain(margin.key);

    const machines = (await as(owner).post('/custom-objects', { singular: 'Machine', plural: 'Machines' })).body.data;
    await as(owner).post('/custom-fields', { object: machines.key, label: 'Cost', type: 'number', access: { agent: 'hidden' } });
    await as(owner).post('/custom-fields', { object: machines.key, label: 'Model', type: 'text' });
    const record = (await as(agent).post('/records', { object: machines.key, name: 'CNC-1', contactId: shared.id, customFields: { model: 'X1' } })).body.data;
    expect((await as(owner).patch(`/records/${record.id}`, { customFields: { cost: 900000 } })).status).toBe(200);
    expect((await as(agent).get(`/records/${record.id}`)).body.data.customFields).toEqual({ model: 'X1' });
    expect((await as(agent).get(`/records?object=${machines.key}`)).body.data[0].customFields).toEqual({ model: 'X1' });
  });

  it('only managers set access, with known values; a change applies at once', async () => {
    expect((await as(agent).patch(`/custom-fields/${field.notes.id}`, { access: { agent: 'hidden' } })).status).toBe(403);
    expect((await as(owner).patch(`/custom-fields/${field.notes.id}`, { access: { agent: 'secret' } })).status).toBe(400);
    expect((await as(owner).patch(`/custom-fields/${field.notes.id}`, { access: { viewer: 'edit' } })).status).toBe(400);
    const changed = await as(owner).patch(`/custom-fields/${field.notes.id}`, { access: { agent: 'view' } });
    expect(changed.body.data.access).toEqual({ agent: 'view', viewer: 'view' });
    expect((await as(agent).get('/custom-fields?object=contact')).body.data.find((f) => f.key === 'visit_notes').canEdit).toBe(false);
    expect((await as(other).patch(`/custom-fields/${field.notes.id}`, { access: { agent: 'edit' } })).status).toBe(404);
  });
});
