jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const { normalizePhone } = require('../utils/phone');
const { financialYear, rupeesToPaise } = require('../utils/money');
const { computeItem, totalsOf } = require('../services/quotationService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

describe('Phone normalization (E.164, +91 default)', () => {
  it.each([
    ['98290 12345', '+919829012345'],
    ['+91 98290-12345', '+919829012345'],
    ['09829012345', '+919829012345'],
    ['919829012345', '+919829012345'],
    ['0091 98290 12345', '+919829012345'],
    ['+1 415 555 2671', '+14155552671'],
    ['', ''],
  ])('%s → %s', (raw, expected) => expect(normalizePhone(raw)).toBe(expected));

  it.each(['12345', 'abc', '+91 98290', '98290123456789012'])('rejects %s', (raw) => expect(normalizePhone(raw)).toBeNull());
});

describe('Money helpers', () => {
  it('converts rupees to paise and names the financial year', () => {
    expect(rupeesToPaise('1,250.50')).toBe(125050);
    expect(rupeesToPaise('')).toBeNull();
    expect(rupeesToPaise(-5)).toBeNull();
    expect(financialYear(new Date('2026-09-24T10:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31T12:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31T19:00:00Z'))).toBe('2027-28'); // already 1 April in India
  });

  it('computes quotation lines on the server in paise', () => {
    const line = computeItem({ quantity: 3, unitPricePaise: 10050, discountPaise: 150, taxRatePct: 18 });
    expect(line).toMatchObject({ subtotalPaise: 30150, discountPaise: 150, taxPaise: 5400, totalPaise: 35400 });
    const capped = computeItem({ quantity: 1, unitPricePaise: 100, discountPaise: 500, taxRatePct: 5 });
    expect(capped.totalPaise).toBe(0);
    expect(totalsOf([line, capped])).toEqual({ subtotalPaise: 30250, discountPaise: 250, taxPaise: 5400, grandTotalPaise: 35400 });
  });
});

describe('Contacts', () => {
  let owner;
  beforeAll(async () => { owner = await login('contacts-owner@example.com'); });

  it('creates a contact with a normalized phone and rejects a duplicate number', async () => {
    const created = await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Ravi Traders', phone: '98290 12345', lifecycle: 'customer' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'Ravi Traders', phoneE164: '+919829012345', lifecycle: 'customer' });

    const duplicate = await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Ravi again', phone: '+91 98290-12345' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('DUPLICATE_CONTACT');

    const badPhone = await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Nope', phone: '123' });
    expect(badPhone.status).toBe(400);
    expect(badPhone.body.errors[0].code).toBe('INVALID_PHONE');
  });

  it('searches, filters and paginates', async () => {
    for (const name of ['Alpha Spices', 'Beta Spices', 'Gamma Foods']) {
      await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name, lifecycle: 'lead' });
    }
    const res = await api().get('/api/v1/contacts?q=spices&lifecycle=lead&limit=1&sort=name').set(bearer(owner.token));
    expect(res.body.data.map((c) => c.name)).toEqual(['Alpha Spices']);
    expect(res.body.pagination).toMatchObject({ total: 2, totalPages: 2, hasNextPage: true });
    const big = await api().get('/api/v1/contacts?limit=500').set(bearer(owner.token));
    expect(big.status).toBe(400);
  });

  it('frees the phone number when a contact is deleted', async () => {
    const first = await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Old Number', phone: '9000000001' });
    await api().delete(`/api/v1/contacts/${first.body.data.id}`).set(bearer(owner.token));
    const again = await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'New Owner Of Number', phone: '9000000001' });
    expect(again.status).toBe(201);
    const gone = await api().get(`/api/v1/contacts/${first.body.data.id}`).set(bearer(owner.token));
    expect(gone.status).toBe(404);
  });
});

describe('Products', () => {
  it('stores prices in paise, lets every member read, only permitted members write', async () => {
    const owner = await login('products-owner@example.com');
    const viewer = await inviteAndJoin(owner.token, 'products-viewer@example.com', { role: 'viewer' });

    const created = await api().post('/api/v1/products').set(bearer(owner.token)).send({ name: 'Cumin 1kg', pricePaise: 25000, gstRatePct: 5, stockQty: 40, hsnSac: '0909' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ pricePaise: 25000, gstRatePct: 5, stockQty: 40 });

    expect((await api().get('/api/v1/products').set(bearer(viewer.token))).body.data).toHaveLength(1);
    const denied = await api().post('/api/v1/products').set(bearer(viewer.token)).send({ name: 'Nope' });
    expect(denied.status).toBe(403);
    const badPrice = await api().post('/api/v1/products').set(bearer(owner.token)).send({ name: 'X', pricePaise: 10.5 });
    expect(badPrice.status).toBe(400);
    const patch = await api().patch(`/api/v1/products/${created.body.data.id}`).set(bearer(owner.token)).send({ stockQty: 35 });
    expect(patch.body.data.stockQty).toBe(35);
  });
});

describe('Leads pipeline', () => {
  let owner;
  beforeAll(async () => { owner = await login('leads-owner@example.com'); });

  const createLead = (token, body) => api().post('/api/v1/leads').set(bearer(token)).send(body);

  it('creates a lead with its contact, reuses the contact for the same phone, and records activity', async () => {
    const first = await createLead(owner.token, { contact: { name: 'Sunita Stores', phone: '9876543210', company: 'Sunita Stores' }, expectedValuePaise: 500000 });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ stage: 'New', probability: 10, contact: { name: 'Sunita Stores', lifecycle: 'lead' } });

    const second = await createLead(owner.token, { contact: { name: 'Sunita (again)', phone: '+91 98765 43210' } });
    expect(second.body.data.contactId).toBe(first.body.data.contactId);

    const activities = await api().get(`/api/v1/leads/${first.body.data.id}/activities`).set(bearer(owner.token));
    expect(activities.body.data.map((a) => a.type)).toEqual(['Lead created']);
  });

  it('sets probability from the stage, requires a reason for Lost and guards versions', async () => {
    const lead = (await createLead(owner.token, { contact: { name: 'Stage Test' } })).body.data;

    const moved = await api().post(`/api/v1/leads/${lead.id}/stage`).set(bearer(owner.token)).send({ stage: 'Quote Sent', version: lead.version });
    expect(moved.body.data).toMatchObject({ stage: 'Quote Sent', probability: 50, version: lead.version + 1 });

    const stale = await api().post(`/api/v1/leads/${lead.id}/stage`).set(bearer(owner.token)).send({ stage: 'Negotiation', version: lead.version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');

    const noReason = await api().post(`/api/v1/leads/${lead.id}/stage`).set(bearer(owner.token)).send({ stage: 'Lost' });
    expect(noReason.status).toBe(422);
    expect(noReason.body.code).toBe('LOST_REASON_REQUIRED');

    const lost = await api().post(`/api/v1/leads/${lead.id}/stage`).set(bearer(owner.token)).send({ stage: 'Lost', lostReason: 'Price too high' });
    expect(lost.body.data).toMatchObject({ stage: 'Lost', probability: 0, lostReason: 'Price too high' });

    const ignoredProbability = await api().patch(`/api/v1/leads/${lead.id}`).set(bearer(owner.token)).send({ probability: 99 });
    expect(ignoredProbability.status).toBe(400); // probability is never accepted from the browser
  });

  it('Won converts the contact to a customer exactly once (idempotent convert)', async () => {
    const lead = (await createLead(owner.token, { contact: { name: 'Convert Me', phone: '9811111111' } })).body.data;
    const first = await api().post(`/api/v1/leads/${lead.id}/convert`).set(bearer(owner.token));
    const second = await api().post(`/api/v1/leads/${lead.id}/convert`).set(bearer(owner.token));
    expect(first.body.data).toMatchObject({ stage: 'Won', probability: 100, contact: { lifecycle: 'customer' } });
    expect(second.body.data.convertedAt).toBe(first.body.data.convertedAt);

    const customers = await api().get('/api/v1/contacts?lifecycle=customer&q=Convert').set(bearer(owner.token));
    expect(customers.body.data).toHaveLength(1);
    const types = (await api().get(`/api/v1/leads/${lead.id}/activities`).set(bearer(owner.token))).body.data.map((a) => a.type);
    expect(types.filter((type) => type === 'Converted')).toHaveLength(1);
  });

  it('a lead created as Won converts too', async () => {
    const lead = await createLead(owner.token, { contact: { name: 'Born Won' }, stage: 'Won' });
    expect(lead.body.data.contact.lifecycle).toBe('customer');
    expect(lead.body.data.convertedAt).not.toBeNull();
  });

  it('edits update the contact and never touch the pipeline stage by accident', async () => {
    const lead = (await createLead(owner.token, { contact: { name: 'Edit Me', company: 'Old Co' }, stage: 'Contacted' })).body.data;
    const edited = await api().patch(`/api/v1/leads/${lead.id}`).set(bearer(owner.token)).send({ contact: { company: 'New Co' }, notes: 'Called twice' });
    expect(edited.body.data).toMatchObject({ stage: 'Contacted', notes: 'Called twice', contact: { company: 'New Co' } });
  });

  it('searches leads by contact details', async () => {
    await createLead(owner.token, { contact: { name: 'Findable Farms', email: 'buyer@findable.example' } });
    const res = await api().get('/api/v1/leads?q=findable').set(bearer(owner.token));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].contact.name).toBe('Findable Farms');
  });
});

describe('Quotations', () => {
  it('numbers drafts per financial year, computes totals on the server and updates the draft', async () => {
    const owner = await login('quotes-owner@example.com');
    const product = (await api().post('/api/v1/products').set(bearer(owner.token)).send({ name: 'Turmeric', pricePaise: 20000, gstRatePct: 5 })).body.data;
    const lead = (await api().post('/api/v1/leads').set(bearer(owner.token)).send({ contact: { name: 'Quote Buyer' } })).body.data;

    const created = await api().post(`/api/v1/leads/${lead.id}/quotations`).set(bearer(owner.token))
      .send({ items: [{ productId: product.id, quantity: 10, unitPricePaise: 20000, taxRatePct: 5, grandTotalPaise: 1 }] });
    expect(created.status).toBe(201);
    expect(created.body.data.number).toMatch(/^QT\/\d{4}-\d{2}\/0001$/);
    expect(created.body.data.totals.grandTotalPaise).toBe(210000);
    expect(created.body.data.items[0].name).toBe('Turmeric');

    const updated = await api().post(`/api/v1/leads/${lead.id}/quotations`).set(bearer(owner.token))
      .send({ items: [{ productId: product.id, quantity: 20, unitPricePaise: 20000, taxRatePct: 5 }] });
    expect(updated.status).toBe(200);
    expect(updated.body.data.number).toBe(created.body.data.number);
    expect(updated.body.data.totals.grandTotalPaise).toBe(420000);

    const sent = await api().patch(`/api/v1/quotations/${created.body.data.id}`).set(bearer(owner.token)).send({ status: 'Sent' });
    expect(sent.body.data.status).toBe('Sent');
    const next = await api().post(`/api/v1/leads/${lead.id}/quotations`).set(bearer(owner.token))
      .send({ items: [{ productId: product.id, quantity: 1, unitPricePaise: 20000 }] });
    expect(next.body.data.number).toMatch(/0002$/);
  });
});

describe('Sales data isolation and record scope', () => {
  it('two members of one organization share data; another organization sees none of it', async () => {
    const ownerA = await login('iso-owner-a@example.com');
    const adminA = await inviteAndJoin(ownerA.token, 'iso-admin-a@example.com', { role: 'admin' });
    const ownerB = await login('iso-owner-b@example.com');

    const lead = (await api().post('/api/v1/leads').set(bearer(ownerA.token)).send({ contact: { name: 'Shared Lead', phone: '9822222222' } })).body.data;
    await api().post('/api/v1/products').set(bearer(ownerA.token)).send({ name: 'Shared Product' });

    const seenByAdmin = await api().get('/api/v1/leads').set(bearer(adminA.token));
    expect(seenByAdmin.body.data.map((l) => l.id)).toContain(lead.id);

    for (const path of ['/api/v1/leads', '/api/v1/contacts', '/api/v1/products', '/api/v1/quotations']) {
      const res = await api().get(path).set(bearer(ownerB.token));
      expect(res.body.data).toEqual([]);
    }
    expect((await api().get(`/api/v1/leads/${lead.id}`).set(bearer(ownerB.token))).status).toBe(404);
    expect((await api().patch(`/api/v1/leads/${lead.id}`).set(bearer(ownerB.token)).send({ notes: 'x' })).status).toBe(404);
    expect((await api().get(`/api/v1/contacts/${lead.contactId}`).set(bearer(ownerB.token))).status).toBe(404);

    // Same phone in another organization is a different contact.
    const other = await api().post('/api/v1/contacts').set(bearer(ownerB.token)).send({ name: 'Same Phone Elsewhere', phone: '9822222222' });
    expect(other.status).toBe(201);
  });

  it('agents see only their own leads unless they have view_all; owner is not taken from agents', async () => {
    const owner = await login('scope-owner@example.com');
    const agent = await inviteAndJoin(owner.token, 'scope-agent@example.com', { role: 'agent' });
    const members = (await api().get('/api/v1/members').set(bearer(owner.token))).body.data;
    const ownerMemberId = members.find((m) => m.email === 'scope-owner@example.com').id;
    const agentMemberId = members.find((m) => m.email === 'scope-agent@example.com').id;

    const ownersLead = (await api().post('/api/v1/leads').set(bearer(owner.token)).send({ contact: { name: 'Owner Lead' } })).body.data;
    const agentsLead = (await api().post('/api/v1/leads').set(bearer(agent.token)).send({ contact: { name: 'Agent Lead' }, ownerId: ownerMemberId })).body.data;
    expect(String(agentsLead.ownerId)).toBe(agentMemberId);

    const agentView = await api().get('/api/v1/leads').set(bearer(agent.token));
    expect(agentView.body.data.map((l) => l.id)).toEqual([agentsLead.id]);
    expect((await api().get(`/api/v1/leads/${ownersLead.id}`).set(bearer(agent.token))).status).toBe(404);
    expect((await api().delete(`/api/v1/leads/${agentsLead.id}`).set(bearer(agent.token))).status).toBe(403);

    await api().patch(`/api/v1/members/${agentMemberId}`).set(bearer(owner.token)).send({ permissions: ['leads:view_all'] });
    const widened = await api().get('/api/v1/leads').set(bearer(agent.token));
    expect(widened.body.data).toHaveLength(2);

    const assigned = await api().patch(`/api/v1/leads/${ownersLead.id}`).set(bearer(owner.token)).send({ ownerId: agentMemberId });
    expect(String(assigned.body.data.ownerId)).toBe(agentMemberId);
  });

  it('agents without the module get 403', async () => {
    const owner = await login('nomodule-owner@example.com');
    const agent = await inviteAndJoin(owner.token, 'nomodule-agent@example.com', { role: 'agent', modules: ['tasks'] });
    expect((await api().get('/api/v1/leads').set(bearer(agent.token))).status).toBe(403);
    expect((await api().get('/api/v1/contacts').set(bearer(agent.token))).status).toBe(403);
    expect((await api().get('/api/v1/products').set(bearer(agent.token))).status).toBe(200);
  });
});
