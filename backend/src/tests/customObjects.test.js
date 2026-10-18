jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const AuditLog = require('../models/AuditLog');
const Contact = require('../models/Contact');
const CustomObjectDefinition = require('../models/CustomObjectDefinition');
const CustomRecord = require('../models/CustomRecord');
const customFieldFilters = require('../services/customFieldFilters');
const { MAX_CUSTOM_OBJECTS } = require('../constants/customFields');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 1C (D75): a company's own objects, their records, and link fields between records.
const as = (user) => ({
  get: (url) => api().get(`/api/v1${url}`).set(bearer(user.token)),
  post: (url, body) => api().post(`/api/v1${url}`).set(bearer(user.token)).send(body),
  patch: (url, body) => api().patch(`/api/v1${url}`).set(bearer(user.token)).send(body),
  del: (url) => api().delete(`/api/v1${url}`).set(bearer(user.token)),
});
const codes = (res) => Object.fromEntries((res.body.errors || []).map((e) => [e.field, e.code]));
const names = (res) => res.body.data.map((r) => r.name).sort();

describe('Custom objects, records and links', () => {
  let owner;
  let admin;
  let agent;
  let viewer;
  let inboxOnly;
  let other;
  let machines;
  let sites;
  let customer;
  let agentCustomer;
  const records = {};

  beforeAll(async () => {
    owner = await login('co-owner@example.com');
    admin = await inviteAndJoin(owner.token, 'co-admin@example.com', { role: 'admin' });
    agent = await inviteAndJoin(owner.token, 'co-agent@example.com', { role: 'agent' });
    viewer = await inviteAndJoin(owner.token, 'co-viewer@example.com', { role: 'viewer' });
    inboxOnly = await inviteAndJoin(owner.token, 'co-inbox@example.com', { role: 'agent', modules: ['inbox'] });
    other = await login('co-other@example.com');
    customer = (await as(owner).post('/contacts', { name: 'Sharma Traders', lifecycle: 'customer' })).body.data;
    agentCustomer = (await as(agent).post('/contacts', { name: 'Agent Customer', lifecycle: 'customer' })).body.data;
  });

  describe('Objects', () => {
    it('owners and admins add objects; keys come from the plural name', async () => {
      const made = await as(owner).post('/custom-objects', { singular: 'Machine', plural: 'Machines', icon: 'gear' });
      expect(made.status).toBe(201);
      expect(made.body.data).toMatchObject({ key: 'x_machines', singular: 'Machine', plural: 'Machines', icon: 'gear', status: 'active', order: 0 });
      machines = made.body.data;
      sites = (await as(admin).post('/custom-objects', { singular: 'Site', plural: 'Sites' })).body.data;
      expect(sites).toMatchObject({ key: 'x_sites', icon: 'box' });
      expect((await as(owner).post('/custom-objects', { singular: 'Machine', plural: 'Machines' })).body.data.key).toBe('x_machines_2');
      expect((await as(owner).post('/custom-objects', { singular: 'मशीन', plural: 'मशीनें' })).body.data.key).toBe('x_object');
      expect((await as(owner).post('/custom-objects', { singular: 'X', plural: 'Xs', icon: 'rocket' })).status).toBe(400);
    });

    it('only managers change them; everyone with Customers reads the active ones', async () => {
      for (const user of [agent, viewer]) expect((await as(user).post('/custom-objects', { singular: 'A', plural: 'As' })).status).toBe(403);
      expect((await as(agent).patch(`/custom-objects/${machines.id}`, { plural: 'Kit' })).status).toBe(403);
      expect((await as(viewer).get('/custom-objects')).status).toBe(200);
      expect((await as(inboxOnly).get('/custom-objects')).status).toBe(403);
      expect((await as(agent).get('/custom-objects?status=all')).status).toBe(403);

      const renamed = await as(owner).patch(`/custom-objects/${machines.id}`, { plural: 'Machines installed', version: 0 });
      expect(renamed.body.data).toMatchObject({ plural: 'Machines installed', key: 'x_machines', version: 1 });
      expect((await as(admin).patch(`/custom-objects/${machines.id}`, { plural: 'Late', version: 0 })).status).toBe(409);
      expect((await as(owner).patch(`/custom-objects/${machines.id}`, { key: 'x_other' })).status).toBe(400);
    });

    it(`allows ${MAX_CUSTOM_OBJECTS} active objects, archived ones not counted, also in parallel`, async () => {
      const boss = await login('co-limit@example.com');
      const first = (await as(boss).post('/custom-objects', { singular: 'One', plural: 'Ones' })).body.data;
      const { organizationId } = await CustomObjectDefinition.findById(first.id);
      await CustomObjectDefinition.insertMany(Array.from({ length: MAX_CUSTOM_OBJECTS - 2 }, (_, i) => ({ organizationId, key: `x_bulk_${i}`, singular: `B${i}`, plural: `Bs${i}`, order: i + 1 })));
      const old = (await as(boss).post('/custom-objects', { singular: 'Old', plural: 'Olds' })).body.data;
      await as(boss).post(`/custom-objects/${old.id}/archive`);
      const results = await Promise.all(['A', 'B', 'C'].map((n) => as(boss).post('/custom-objects', { singular: n, plural: `${n}s` })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 422, 422]);
      expect(results.find((r) => r.status === 422).body.code).toBe('OBJECT_LIMIT');
      expect((await as(boss).post(`/custom-objects/${old.id}/restore`)).body.code).toBe('OBJECT_LIMIT');
    });
  });

  describe('Fields on objects, and link fields', () => {
    it('objects get fields like customers do', async () => {
      const serial = await as(owner).post('/custom-fields', { object: 'x_machines', label: 'Serial', type: 'text', listColumn: true });
      expect(serial.status).toBe(201);
      await as(owner).post('/custom-fields', { object: 'x_machines', label: 'Warranty till', type: 'date' });
      await as(owner).post('/custom-fields', { object: 'x_machines', label: 'Hours', type: 'number', required: true });
      expect((await as(agent).get('/custom-fields?object=x_machines')).body.data.map((f) => f.key)).toEqual(['serial', 'warranty_till', 'hours']);
      expect((await as(inboxOnly).get('/custom-fields?object=x_machines')).status).toBe(403);
      expect((await as(owner).post('/custom-fields', { object: 'x_nope', label: 'A', type: 'text' })).status).toBe(404);
      expect((await as(other).post('/custom-fields', { object: 'x_machines', label: 'Theirs', type: 'text' })).status).toBe(404);
      expect((await as(other).get('/custom-fields?object=x_machines')).status).toBe(404);
    });

    it('a link field points to customers, leads or an active object, and that never changes', async () => {
      const link = await as(owner).post('/custom-fields', { object: 'contact', label: 'Main machine', type: 'lookup', lookupTarget: 'x_machines' });
      expect(link.status).toBe(201);
      expect(link.body.data).toMatchObject({ key: 'main_machine', type: 'lookup', lookupTarget: 'x_machines' });
      await as(owner).post('/custom-fields', { object: 'x_machines', label: 'Installed for', type: 'lookup', lookupTarget: 'lead' });
      await as(owner).post('/custom-fields', { object: 'x_machines', label: 'At site', type: 'lookup', lookupTarget: 'x_sites' });
      const bad = await as(owner).post('/custom-fields', { object: 'contact', label: 'Bad', type: 'lookup', lookupTarget: 'x_nope' });
      expect(bad.body.errors[0].code).toBe('INVALID_LINK_TARGET');
      expect((await as(other).post('/custom-fields', { object: 'contact', label: 'Theirs', type: 'lookup', lookupTarget: 'x_machines' })).body.errors[0].code).toBe('INVALID_LINK_TARGET');
      expect((await as(owner).post('/custom-fields', { object: 'contact', label: 'No target', type: 'lookup' })).status).toBe(400);
      expect((await as(owner).post('/custom-fields', { object: 'contact', label: 'Text', type: 'text', lookupTarget: 'lead' })).status).toBe(400);
      expect((await as(owner).patch(`/custom-fields/${link.body.data.id}`, { lookupTarget: 'lead' })).status).toBe(400);
    });
  });

  describe('Records', () => {
    it('are added with the Customers permissions, a customer and the object fields', async () => {
      const made = await as(owner).post('/records', { object: 'x_machines', name: 'CNC-200 #1', contactId: customer.id, customFields: { serial: 'S-1', hours: 120 } });
      expect(made.status).toBe(201);
      expect(made.body.data).toMatchObject({ object: 'x_machines', name: 'CNC-200 #1', contact: { id: customer.id, name: 'Sharma Traders' }, customFields: { serial: 'S-1', hours: 120 }, version: 0 });
      records.owners = made.body.data;
      const missing = await as(owner).post('/records', { object: 'x_machines', name: 'No hours', customFields: { serial: 'S-2' } });
      expect(missing.body.errors).toEqual([expect.objectContaining({ field: 'customFields.hours', code: 'REQUIRED' })]);
      records.agents = (await as(agent).post('/records', { object: 'x_machines', name: 'Lathe 9', contactId: agentCustomer.id, customFields: { hours: 5 } })).body.data;
      records.site = (await as(owner).post('/records', { object: 'x_sites', name: 'Jaipur plant', contactId: customer.id })).body.data;
      expect((await as(viewer).post('/records', { object: 'x_machines', name: 'Nope' })).status).toBe(403);
      expect((await as(owner).post('/records', { object: 'x_nope', name: 'Nope' })).status).toBe(404);
    });

    it('agents see and change only their own unless they may see all', async () => {
      expect(names(await as(agent).get('/records?object=x_machines'))).toEqual(['Lathe 9']);
      expect(names(await as(owner).get('/records?object=x_machines'))).toEqual(['CNC-200 #1', 'Lathe 9']);
      expect((await as(agent).get(`/records/${records.owners.id}`)).status).toBe(404);
      expect((await as(agent).patch(`/records/${records.owners.id}`, { name: 'Mine' })).status).toBe(404);
      // An agent may only link to a customer they can see.
      const linked = await as(agent).post('/records', { object: 'x_machines', name: 'Sneaky', contactId: customer.id, customFields: { hours: 1 } });
      expect(codes(linked)).toEqual({ contactId: 'INVALID_LINK' });
      expect((await as(agent).del(`/records/${records.agents.id}`)).status).toBe(403); // no customers:delete
    });

    it('edits with version checks, filters and searches like customers', async () => {
      const edited = await as(owner).patch(`/records/${records.owners.id}`, { name: 'CNC-200 main', customFields: { hours: 150 }, version: 0 });
      expect(edited.body.data).toMatchObject({ name: 'CNC-200 main', customFields: { serial: 'S-1', hours: 150 }, version: 1 });
      expect((await as(owner).patch(`/records/${records.owners.id}`, { name: 'Late', version: 0 })).status).toBe(409);
      expect(names(await as(owner).get(`/records?object=x_machines&cf=${encodeURIComponent('hours:gte:100')}`))).toEqual(['CNC-200 main']);
      expect(names(await as(owner).get('/records?object=x_machines&q=S-1'))).toEqual(['CNC-200 main']);
      expect(names(await as(owner).get('/records?object=x_machines&q=lathe'))).toEqual(['Lathe 9']);
    });

    it("lists a customer's records of every object (Customer 360)", async () => {
      const res = await as(owner).get(`/records?contactId=${customer.id}`);
      expect(res.body.data.map((r) => `${r.object}:${r.name}`).sort()).toEqual(['x_machines:CNC-200 main', 'x_sites:Jaipur plant']);
    });

    it('global search finds records', async () => {
      const res = await as(owner).get('/search?q=Jaipur plant');
      const group = res.body.data.groups.find((g) => g.type === 'records');
      expect(group.items[0]).toMatchObject({ title: 'Jaipur plant', subtitle: 'Site · Sharma Traders', url: `records.html?object=x_sites&open=${records.site.id}` });
      expect((await as(inboxOnly).get('/search?q=Jaipur plant')).body.data.groups.find((g) => g.type === 'records')).toBeUndefined();
    });
  });

  describe('Links', () => {
    it('link a customer to a machine and show its name', async () => {
      const res = await as(owner).patch(`/contacts/${customer.id}`, { customFields: { main_machine: records.owners.id } });
      expect(res.status).toBe(200);
      expect(res.body.data.customFieldLinks).toEqual({ main_machine: { id: records.owners.id, name: 'CNC-200 main' } });
      const listed = (await as(owner).get('/contacts?q=Sharma')).body.data[0];
      expect(listed.customFieldLinks.main_machine.name).toBe('CNC-200 main');
      expect(names(await as(owner).get(`/contacts?cf=${encodeURIComponent(`main_machine:is:${records.owners.id}`)}`))).toEqual(['Sharma Traders']);
      expect(names(await as(owner).get(`/contacts?cf=${encodeURIComponent('main_machine:filled')}`))).toEqual(['Sharma Traders']);
      expect((await as(owner).get(`/contacts?cf=${encodeURIComponent('main_machine:is:nope')}`)).body.errors[0].code).toBe('INVALID_FILTER');
    });

    it('refuses every link it may not make', async () => {
      const otherObject = (await as(other).post('/custom-objects', { singular: 'Machine', plural: 'Machines' })).body.data;
      expect(otherObject.key).toBe('x_machines'); // the same key in another company
      const theirs = (await as(other).post('/records', { object: 'x_machines', name: 'Their machine' })).body.data;
      const deleted = (await as(owner).post('/records', { object: 'x_machines', name: 'Gone', customFields: { hours: 1 } })).body.data;
      await as(owner).del(`/records/${deleted.id}`);
      const bad = { malformed: 'abc', otherCompany: theirs.id, deleted: deleted.id, wrongKind: records.site.id, notAContactId: customer.id };
      for (const [why, id] of Object.entries(bad)) {
        const res = await as(owner).patch(`/contacts/${customer.id}`, { customFields: { main_machine: id } });
        expect({ why, code: codes(res)['customFields.main_machine'] }).toEqual({ why, code: 'INVALID_LINK' });
      }
      // An agent cannot link to a record they may not see.
      const agentLink = await as(agent).patch(`/contacts/${agentCustomer.id}`, { customFields: { main_machine: records.owners.id } });
      expect(codes(agentLink)).toEqual({ 'customFields.main_machine': 'INVALID_LINK' });
    });

    it("shows a link the viewer may not see as hidden, and a deleted one as missing", async () => {
      await as(owner).patch(`/contacts/${agentCustomer.id}`, { customFields: { main_machine: records.owners.id } });
      const seenByAgent = (await as(agent).get(`/contacts/${agentCustomer.id}`)).body.data;
      expect(seenByAgent.customFieldLinks.main_machine).toEqual({ id: records.owners.id, hidden: true });
      // Keeping the link it has (unchanged) is fine for the agent.
      expect((await as(agent).patch(`/contacts/${agentCustomer.id}`, { customFields: { main_machine: records.owners.id } })).status).toBe(200);

      const temp = (await as(owner).post('/records', { object: 'x_machines', name: 'Temp', customFields: { hours: 2 } })).body.data;
      await as(owner).patch(`/contacts/${customer.id}`, { customFields: { main_machine: temp.id } });
      await as(owner).del(`/records/${temp.id}`);
      expect((await as(owner).get(`/contacts/${customer.id}`)).body.data.customFieldLinks.main_machine).toEqual({ id: temp.id, missing: true });
      await as(owner).patch(`/contacts/${customer.id}`, { customFields: { main_machine: records.owners.id } });
    });

    it('links from a record to a lead and to another object', async () => {
      const lead = (await as(owner).post('/leads', { contact: { name: 'Lead Buyer', phone: '9666600001' }, title: 'Pump order' })).body.data;
      const res = await as(owner).patch(`/records/${records.owners.id}`, { customFields: { installed_for: lead.id, at_site: records.site.id } });
      expect(res.body.data.customFieldLinks).toEqual({
        installed_for: { id: lead.id, name: 'Pump order' },
        at_site: { id: records.site.id, name: 'Jaipur plant' },
      });
    });

    it('the picker searches what the member may see', async () => {
      expect((await as(owner).get('/lookup?target=x_machines&q=cnc')).body.data.map((r) => r.name)).toEqual(['CNC-200 main']);
      expect((await as(agent).get('/lookup?target=x_machines')).body.data.map((r) => r.name)).toEqual(['Lathe 9']);
      expect((await as(owner).get('/lookup?target=contact&q=sharma')).body.data).toEqual([{ id: customer.id, name: 'Sharma Traders', subtitle: '' }]);
      expect((await as(owner).get('/lookup?target=lead&q=pump')).body.data[0]).toMatchObject({ name: 'Pump order', subtitle: 'Lead Buyer · New' });
      expect((await as(inboxOnly).get('/lookup?target=contact')).status).toBe(403);
      expect((await as(owner).get('/lookup?target=x_nope')).status).toBe(404);
      expect((await as(other).get('/lookup?target=x_machines')).body.data.map((r) => r.name)).toEqual(['Their machine']);
    });
  });

  describe('Another company', () => {
    it('sees none of the records and cannot change them', async () => {
      expect(names(await as(other).get('/records?object=x_machines'))).toEqual(['Their machine']);
      expect((await as(other).get(`/records/${records.owners.id}`)).status).toBe(404);
      expect((await as(other).patch(`/records/${records.owners.id}`, { name: 'Mine' })).status).toBe(404);
      expect((await as(other).del(`/records/${records.owners.id}`)).status).toBe(404);
      expect((await as(other).get('/records?object=x_sites')).status).toBe(404);
      expect((await as(other).get(`/records?contactId=${customer.id}`)).body.data).toEqual([]);
      expect((await CustomRecord.findById(records.owners.id)).name).toBe('CNC-200 main');
    });
  });

  describe('Archiving an object', () => {
    it('hides it and its records, keeps existing links, and brings everything back on restore', async () => {
      await as(owner).post(`/custom-objects/${sites.id}/archive`);
      expect((await as(owner).get('/custom-objects')).body.data.map((o) => o.key)).not.toContain('x_sites');
      expect((await as(owner).get('/records?object=x_sites')).status).toBe(404);
      expect((await as(owner).get(`/records/${records.site.id}`)).status).toBe(404);
      expect((await as(owner).get(`/records?contactId=${customer.id}`)).body.data.map((r) => r.object)).toEqual(['x_machines']);
      // The machine's link to the site keeps its name; a new link to an archived object is refused.
      const machine = (await as(owner).get(`/records/${records.owners.id}`)).body.data;
      expect(machine.customFieldLinks.at_site).toEqual({ id: records.site.id, name: 'Jaipur plant' });
      const other2 = (await as(owner).post('/records', { object: 'x_machines', name: 'Second', customFields: { hours: 3, at_site: records.site.id } }));
      expect(codes(other2)).toEqual({ 'customFields.at_site': 'INVALID_LINK' });
      expect((await as(owner).post('/custom-fields', { object: 'contact', label: 'Site link', type: 'lookup', lookupTarget: 'x_sites' })).body.errors[0].code).toBe('INVALID_LINK_TARGET');

      await as(owner).post(`/custom-objects/${sites.id}/restore`);
      expect((await as(owner).get(`/records/${records.site.id}`)).status).toBe(200);
    });
  });

  describe('Export, index and audit', () => {
    it('the full export has the objects and the records', async () => {
      const res = await api().get('/api/v1/exports/crm').set(bearer(owner.token));
      expect(res.body.customObjects.map((o) => o.key)).toEqual(expect.arrayContaining(['x_machines', 'x_sites']));
      expect(res.body.customRecords.map((r) => r.name)).toEqual(expect.arrayContaining(['CNC-200 main', 'Lathe 9', 'Jaipur plant']));
      expect(res.body.customRecords.map((r) => r.name)).not.toContain('Gone'); // deleted
    });

    it('records get the filter index too', async () => {
      expect(await customFieldFilters.ensureValueIndexes()).toBe(true);
      expect((await CustomRecord.collection.indexes()).map((i) => i.name)).toContain('organizationId_1_customFields_wildcard');
    });

    it('every change is in the audit log', async () => {
      const actions = await AuditLog.distinct('action', { entityType: { $in: ['CustomObjectDefinition', 'CustomRecord'] } });
      expect(actions).toEqual(expect.arrayContaining(['custom_object.created', 'custom_object.updated', 'custom_object.archived', 'custom_object.restored', 'record.created', 'record.updated', 'record.deleted']));
      expect(await Contact.countDocuments({ name: 'Sharma Traders' })).toBe(1);
    });
  });
});
