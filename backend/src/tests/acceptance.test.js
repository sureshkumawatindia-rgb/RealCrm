jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const { MODULES } = require('../constants/permissions');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 2 acceptance: everything the CRM keeps is shared inside one organization and invisible
// to every other organization.
const RESOURCES = ['contacts', 'products', 'leads', 'quotations', 'tasks', 'events', 'tickets', 'documents', 'campaigns', 'workflows', 'sequences'];

describe('Phase 2 acceptance: one organization, one set of data', () => {
  let owner;
  let admin;
  let agent;
  let stranger;
  const created = {};

  beforeAll(async () => {
    owner = await login('acc-owner@example.com', { name: 'Asha' });
    admin = await inviteAndJoin(owner.token, 'acc-admin@example.com', { role: 'admin' });
    // An agent with every page and "See all records" everywhere.
    agent = await inviteAndJoin(owner.token, 'acc-agent@example.com', {
      role: 'agent', modules: [...MODULES], permissions: MODULES.map((module) => `${module}:view_all`),
    });
    stranger = await login('acc-stranger@example.com');

    const post = async (path, body) => {
      const res = await api().post(`/api/v1${path}`).set(bearer(owner.token)).send(body);
      if (res.status >= 300) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.data;
    };
    created.contacts = await post('/contacts', { name: 'Ravi Traders', phone: '9829012345', lifecycle: 'customer' });
    created.products = await post('/products', { name: 'Cumin 1kg', pricePaise: 25000, gstRatePct: 5 });
    created.leads = await post('/leads', { contactId: created.contacts.id, title: 'Diwali order', productId: created.products.id });
    created.quotations = await post(`/leads/${created.leads.id}/quotations`, {
      items: [{ productId: created.products.id, quantity: 2, unitPricePaise: 25000, taxRatePct: 5 }],
    });
    created.tasks = await post('/tasks', { title: 'Call Ravi', relatedType: 'Customer', relatedId: created.contacts.id });
    created.events = await post('/events', { title: 'Shop visit', date: '2026-10-05', startTime: '11:00' });
    created.tickets = await post('/tickets', { subject: 'Late delivery', contactId: created.contacts.id });
    created.ticketNote = await post(`/tickets/${created.tickets.id}/notes`, { text: 'Courier says Friday' });
    created.contactNote = await post(`/contacts/${created.contacts.id}/notes`, { text: 'Pays by UPI' });
    created.documents = await post('/documents', { name: 'Catalogue', linkUrl: 'https://example.com/catalogue.pdf' });
    created.campaigns = await post('/campaigns', { name: 'Diwali SMS', type: 'SMS' });
    created.workflows = await post('/workflows', { name: 'Welcome', trigger: 'Lead Created' });
    created.sequences = await post('/sequences', { name: 'Follow-up', steps: [{ day: 0, type: 'Call' }] });
  });

  const list = (user, resource) => api().get(`/api/v1/${resource}?limit=100`).set(bearer(user.token));
  const ids = (res) => res.body.data.map((record) => String(record.id)).sort();

  it('an admin and an agent with "See all records" see exactly what the owner sees', async () => {
    for (const resource of RESOURCES) {
      const [byOwner, byAdmin, byAgent] = await Promise.all([owner, admin, agent].map((user) => list(user, resource)));
      expect({ resource, status: byOwner.status }).toEqual({ resource, status: 200 });
      expect(ids(byOwner)).toContain(String(created[resource].id));
      expect({ resource, ids: ids(byAdmin) }).toEqual({ resource, ids: ids(byOwner) });
      expect({ resource, ids: ids(byAgent) }).toEqual({ resource, ids: ids(byOwner) });
    }
    for (const user of [admin, agent]) {
      const notes = await api().get(`/api/v1/tickets/${created.tickets.id}/notes`).set(bearer(user.token));
      expect(notes.body.data.map((n) => n.text)).toEqual(['Courier says Friday']);
      const contactNotes = await api().get(`/api/v1/contacts/${created.contacts.id}/notes`).set(bearer(user.token));
      expect(contactNotes.body.data.map((n) => n.text)).toEqual(['Pays by UPI']);
    }
  });

  it('another organization sees none of it, not even with the ids', async () => {
    for (const resource of RESOURCES) {
      const res = await list(stranger, resource);
      expect({ resource, data: res.body.data }).toEqual({ resource, data: [] });
      const byId = await api().get(`/api/v1/${resource}/${created[resource].id}`).set(bearer(stranger.token));
      expect({ resource, status: byId.status }).toEqual({ resource, status: 404 });
    }
    const probes = [
      api().get(`/api/v1/tickets/${created.tickets.id}/notes`),
      api().get(`/api/v1/contacts/${created.contacts.id}/notes`),
      api().get(`/api/v1/leads/${created.leads.id}/activities`),
      api().get(`/api/v1/documents/${created.documents.id}/download`),
      api().post(`/api/v1/workflows/${created.workflows.id}/run`),
      api().patch(`/api/v1/tasks/${created.tasks.id}`).send({ title: 'Hijacked' }),
      api().delete(`/api/v1/campaigns/${created.campaigns.id}`),
    ];
    for (const probe of probes) expect((await probe.set(bearer(stranger.token))).status).toBe(404);
    // Nothing above changed the owner's records.
    expect((await api().get(`/api/v1/tasks/${created.tasks.id}`).set(bearer(owner.token))).body.data.title).toBe('Call Ravi');
    expect((await api().get(`/api/v1/campaigns/${created.campaigns.id}`).set(bearer(owner.token))).status).toBe(200);
  });

  describe('GET /exports/crm', () => {
    it('downloads the organization\'s records without secrets, internal fields or deleted records', async () => {
      const extra = (await api().post('/api/v1/campaigns').set(bearer(owner.token)).send({ name: 'Deleted later' })).body.data;
      await api().delete(`/api/v1/campaigns/${extra.id}`).set(bearer(owner.token));

      const res = await api().get('/api/v1/exports/crm').set(bearer(owner.token));
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="crm-export-\d{4}-\d{2}-\d{2}\.json"/);
      expect(res.headers['cache-control']).toBe('private, no-store');
      const file = res.body;
      expect(file).toMatchObject({ format: 'yellow-crm-export', version: 1 });
      expect(file.team.map((m) => m.email).sort()).toEqual(['acc-admin@example.com', 'acc-agent@example.com', 'acc-owner@example.com']);
      for (const resource of RESOURCES.filter((r) => r !== 'events')) {
        expect(file[resource].map((r) => String(r._id))).toContain(String(created[resource].id));
      }
      expect(file.events.map((e) => e.title)).toEqual(['Shop visit']);
      expect(file.notes.map((n) => n.text).sort()).toEqual(['Courier says Friday', 'Pays by UPI']);
      expect(file.campaigns.map((c) => c.name)).toEqual(['Diwali SMS']);

      const text = JSON.stringify(file);
      for (const secret of ['organizationId', 'storageKey', 'tokenHash', 'deletedAt', 'refresh']) expect(text).not.toContain(secret);
    });

    it('is only for owners and admins, and holds only the caller\'s organization', async () => {
      expect((await api().get('/api/v1/exports/crm').set(bearer(agent.token))).status).toBe(403);
      expect((await api().get('/api/v1/exports/crm').set(bearer(admin.token))).status).toBe(200);
      const theirs = (await api().get('/api/v1/exports/crm').set(bearer(stranger.token))).body;
      expect(theirs.contacts).toEqual([]);
      expect(theirs.team.map((m) => m.email)).toEqual(['acc-stranger@example.com']);
    });
  });
});
