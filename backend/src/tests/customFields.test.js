jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const AuditLog = require('../models/AuditLog');
const Contact = require('../models/Contact');
const CustomFieldDefinition = require('../models/CustomFieldDefinition');
const { MAX_ACTIVE_FIELDS } = require('../constants/customFields');
const { api, bearer, loginWithApi: login, inviteAndJoin } = require('./helpers/api'); // companies on Scale: the API needs it (D125)

// Phase 1A (D73): a company's own fields on customers and leads.
const as = (user) => ({
  get: (path) => api().get(`/api/v1${path}`).set(bearer(user.token)),
  post: (path, body) => api().post(`/api/v1${path}`).set(bearer(user.token)).send(body),
  patch: (path, body) => api().patch(`/api/v1${path}`).set(bearer(user.token)).send(body),
});
const codes = (res) => Object.fromEntries((res.body.errors || []).map((e) => [e.field, e.code]));

describe('Custom fields', () => {
  let owner;
  let admin;
  let agent;
  let viewer;
  let inboxOnly;
  let other;
  const fields = {};

  beforeAll(async () => {
    owner = await login('cf-owner@example.com');
    admin = await inviteAndJoin(owner.token, 'cf-admin@example.com', { role: 'admin' });
    agent = await inviteAndJoin(owner.token, 'cf-agent@example.com', { role: 'agent' });
    viewer = await inviteAndJoin(owner.token, 'cf-viewer@example.com', { role: 'viewer' });
    inboxOnly = await inviteAndJoin(owner.token, 'cf-inbox@example.com', { role: 'agent', modules: ['inbox'] });
    other = await login('cf-other@example.com');
  });

  describe('Settings: the fields themselves', () => {
    it('owners and admins add fields of every type; keys come from the label', async () => {
      const make = async (user, body) => {
        const res = await as(user).post('/custom-fields', body);
        expect(res.status).toBe(201);
        return res.body.data;
      };
      fields.model = await make(owner, { object: 'contact', label: 'Machine model', type: 'text', helpText: 'As on the bill' });
      fields.notes = await make(owner, { object: 'contact', label: 'Site notes', type: 'textarea' });
      fields.credit = await make(admin, { object: 'contact', label: 'Credit days', type: 'number' });
      fields.visit = await make(admin, { object: 'contact', label: 'Visit date', type: 'date' });
      fields.dealer = await make(owner, { object: 'contact', label: 'Dealer type', type: 'dropdown', options: [{ label: 'Retail' }, { label: 'Wholesale' }, { label: 'Distributor' }] });
      fields.gst = await make(owner, { object: 'contact', label: 'GST registered', type: 'checkbox' });
      fields.again = await make(owner, { object: 'contact', label: 'Visit date', type: 'text' });

      expect(fields.model).toMatchObject({ key: 'machine_model', type: 'text', helpText: 'As on the bill', required: false, status: 'active', order: 0, version: 0 });
      expect(fields.again.key).toBe('visit_date_2');
      expect(fields.dealer.options).toEqual([
        { value: 'o1', label: 'Retail', archived: false },
        { value: 'o2', label: 'Wholesale', archived: false },
        { value: 'o3', label: 'Distributor', archived: false },
      ]);
      const listed = await as(owner).get('/custom-fields?object=contact');
      expect(listed.body.data.map((f) => f.key)).toEqual(['machine_model', 'site_notes', 'credit_days', 'visit_date', 'dealer_type', 'gst_registered', 'visit_date_2']);
    });

    it('refuses bad definitions', async () => {
      const bad = async (body, status = 400) => expect((await as(owner).post('/custom-fields', body)).status).toBe(status);
      await bad({ object: 'ticket', label: 'X', type: 'text' });
      await bad({ object: 'contact', label: 'X', type: 'phone' });
      await bad({ object: 'contact', label: '', type: 'text' });
      await bad({ object: 'contact', label: 'Size', type: 'dropdown' });
      await bad({ object: 'contact', label: 'Size', type: 'dropdown', options: [{ label: 'S' }, { label: 's' }] });
      await bad({ object: 'contact', label: 'Size', type: 'text', options: [{ label: 'S' }] });
    });

    it('edits label, help text, required and choices; never the type or the key', async () => {
      const edited = await as(owner).patch(`/custom-fields/${fields.dealer.id}`, {
        label: 'Dealer kind', version: 0, options: [{ value: 'o1', label: 'Retailer' }, { value: 'o2', label: 'Wholesale' }, { label: 'Export' }],
      });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({ label: 'Dealer kind', key: 'dealer_type', version: 1 });
      // Distributor was left out: archived, not lost. Export got the next value.
      expect(edited.body.data.options).toEqual([
        { value: 'o1', label: 'Retailer', archived: false },
        { value: 'o2', label: 'Wholesale', archived: false },
        { value: 'o4', label: 'Export', archived: false },
        { value: 'o3', label: 'Distributor', archived: true },
      ]);
      fields.dealer = edited.body.data;

      const stale = await as(admin).patch(`/custom-fields/${fields.dealer.id}`, { label: 'Late', version: 0 });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      for (const body of [{ type: 'text' }, { key: 'other' }, { object: 'lead' }]) {
        expect((await as(owner).patch(`/custom-fields/${fields.dealer.id}`, body)).status).toBe(400);
      }
      expect((await as(owner).patch(`/custom-fields/${fields.model.id}`, { options: [{ label: 'A' }] })).status).toBe(400);
      expect((await as(owner).patch(`/custom-fields/${fields.dealer.id}`, { options: [{ value: 'o9', label: 'Ghost' }] })).status).toBe(400);
    });

    it('lets the team read the fields of what they can view, and only managers change them', async () => {
      expect((await as(agent).get('/custom-fields?object=contact')).status).toBe(200);
      expect((await as(viewer).get('/custom-fields?object=lead')).status).toBe(200);
      expect((await as(inboxOnly).get('/custom-fields?object=contact')).status).toBe(403);
      expect((await as(agent).get('/custom-fields?object=contact&status=all')).status).toBe(403);
      for (const user of [agent, viewer]) {
        expect((await as(user).post('/custom-fields', { object: 'contact', label: 'Nope', type: 'text' })).status).toBe(403);
        expect((await as(user).patch(`/custom-fields/${fields.model.id}`, { label: 'Nope' })).status).toBe(403);
        expect((await as(user).post(`/custom-fields/${fields.model.id}/archive`)).status).toBe(403);
        expect((await as(user).post(`/custom-fields/${fields.model.id}/restore`)).status).toBe(403);
        expect((await as(user).post('/custom-fields/reorder', { object: 'contact', ids: [fields.model.id] })).status).toBe(403);
      }
    });

    it('reorders with the full list of active fields only', async () => {
      const ids = (await as(owner).get('/custom-fields?object=contact')).body.data.map((f) => f.id);
      const reversed = [...ids].reverse();
      const res = await as(owner).post('/custom-fields/reorder', { object: 'contact', ids: reversed });
      expect(res.status).toBe(200);
      expect(res.body.data.map((f) => f.id)).toEqual(reversed);
      expect((await as(owner).post('/custom-fields/reorder', { object: 'contact', ids: ids.slice(1) })).status).toBe(400);
      expect((await as(owner).post('/custom-fields/reorder', { object: 'contact', ids: [...ids.slice(1), ids[1]] })).status).toBe(400);
      await as(owner).post('/custom-fields/reorder', { object: 'contact', ids });
    });
  });

  describe('Values on customers', () => {
    let contactId;

    it('saves every type, converted, and returns them', async () => {
      const res = await as(owner).post('/contacts', {
        name: 'Field Traders',
        customFields: {
          machine_model: '  CNC-200 ', site_notes: 'Line 1\nLine 2', credit_days: '30', visit_date: '2026-10-20', dealer_type: 'o2', gst_registered: true, visit_date_2: '',
        },
      });
      expect(res.status).toBe(201);
      expect(res.body.data.customFields).toEqual({
        machine_model: 'CNC-200', site_notes: 'Line 1\nLine 2', credit_days: 30, visit_date: '2026-10-20', dealer_type: 'o2', gst_registered: true,
      });
      contactId = res.body.data.id;
      const listed = (await as(owner).get('/contacts?q=Field Traders')).body.data[0];
      expect(listed.customFields.credit_days).toBe(30);
    });

    it('refuses wrong values and names each field', async () => {
      const res = await as(owner).patch(`/contacts/${contactId}`, {
        customFields: {
          machine_model: 'x'.repeat(256), site_notes: 'y'.repeat(2001), credit_days: 'thirty', visit_date: '2026-02-30', dealer_type: 'o99', gst_registered: 'yes', made_up: 'z',
        },
      });
      expect(res.status).toBe(400);
      expect(codes(res)).toEqual({
        'customFields.machine_model': 'TOO_LONG',
        'customFields.site_notes': 'TOO_LONG',
        'customFields.credit_days': 'INVALID_TYPE',
        'customFields.visit_date': 'INVALID_TYPE',
        'customFields.dealer_type': 'INVALID_OPTION',
        'customFields.gst_registered': 'INVALID_TYPE',
        'customFields.made_up': 'UNKNOWN_FIELD',
      });
      for (const credit of [1.234, 1e13, '1e5']) {
        const number = await as(owner).patch(`/contacts/${contactId}`, { customFields: { credit_days: credit } });
        expect(number.status).toBe(400);
      }
      // Nothing was saved.
      expect((await as(owner).get(`/contacts/${contactId}`)).body.data.customFields.machine_model).toBe('CNC-200');
    });

    it('changes only the keys sent; empty clears one', async () => {
      const res = await as(owner).patch(`/contacts/${contactId}`, { customFields: { credit_days: 45.5, machine_model: '', gst_registered: false } });
      expect(res.status).toBe(200);
      expect(res.body.data.customFields).toEqual({ site_notes: 'Line 1\nLine 2', credit_days: 45.5, visit_date: '2026-10-20', dealer_type: 'o2' });
      const plain = await as(owner).patch(`/contacts/${contactId}`, { city: 'Jaipur' });
      expect(plain.body.data.customFields.credit_days).toBe(45.5);
    });

    it('keeps an archived choice on a record that has it, but it cannot be picked again', async () => {
      await Contact.updateOne({ _id: contactId }, { $set: { 'customFields.dealer_type': 'o3' } });
      expect((await as(owner).patch(`/contacts/${contactId}`, { customFields: { dealer_type: 'o3', credit_days: 10 } })).status).toBe(200);
      const fresh = await as(owner).post('/contacts', { name: 'Late Distributor', customFields: { dealer_type: 'o3' } });
      expect(fresh.status).toBe(400);
      expect(codes(fresh)['customFields.dealer_type']).toBe('INVALID_OPTION');
    });

    it('lets agents fill in the fields of their own customers', async () => {
      const res = await as(agent).post('/contacts', { name: 'Agent Customer', customFields: { machine_model: 'A-1' } });
      expect(res.status).toBe(201);
      expect(res.body.data.customFields).toEqual({ machine_model: 'A-1' });
      expect((await as(viewer).patch(`/contacts/${res.body.data.id}`, { customFields: { machine_model: 'V' } })).status).toBe(403);
    });
  });

  describe('Archive and restore', () => {
    it('hides an archived field and its values, and brings both back', async () => {
      const contact = (await as(owner).post('/contacts', { name: 'Archive Check', customFields: { site_notes: 'keep me' } })).body.data;
      const archived = await as(owner).post(`/custom-fields/${fields.notes.id}/archive`);
      expect(archived.body.data.status).toBe('archived');
      expect((await as(owner).post(`/custom-fields/${fields.notes.id}/archive`)).status).toBe(200); // harmless again

      expect((await as(owner).get('/custom-fields?object=contact')).body.data.map((f) => f.key)).not.toContain('site_notes');
      expect((await as(owner).get('/custom-fields?object=contact&status=all')).body.data.map((f) => f.key)).toContain('site_notes');
      expect((await as(owner).get(`/contacts/${contact.id}`)).body.data.customFields).toEqual({});
      const write = await as(owner).patch(`/contacts/${contact.id}`, { customFields: { site_notes: 'new' } });
      expect(codes(write)['customFields.site_notes']).toBe('FIELD_ARCHIVED');
      expect((await Contact.findById(contact.id)).customFields).toEqual({ site_notes: 'keep me' });

      const restored = await as(owner).post(`/custom-fields/${fields.notes.id}/restore`);
      expect(restored.body.data).toMatchObject({ status: 'active', archivedAt: null });
      expect((await as(owner).get(`/contacts/${contact.id}`)).body.data.customFields).toEqual({ site_notes: 'keep me' });
    });
  });

  describe('Required fields', () => {
    let requiredField;
    beforeAll(async () => {
      requiredField = (await as(owner).post('/custom-fields', { object: 'contact', label: 'Region', type: 'text', required: true })).body.data;
    });
    afterAll(async () => { await as(owner).post(`/custom-fields/${requiredField.id}/archive`); });

    it('a new customer from the form must fill it', async () => {
      const res = await as(owner).post('/contacts', { name: 'No Region', customFields: { machine_model: 'X' } });
      expect(res.status).toBe(400);
      expect(codes(res)).toEqual({ 'customFields.region': 'REQUIRED' });
      expect((await as(owner).post('/contacts', { name: 'With Region', customFields: { region: 'North' } })).status).toBe(201);
    });

    it('an edit may not empty it, but edits that do not send it still work', async () => {
      const contact = (await as(owner).post('/contacts', { name: 'Region Edit', customFields: { region: 'West' } })).body.data;
      expect(codes(await as(owner).patch(`/contacts/${contact.id}`, { customFields: { region: '' } }))).toEqual({ 'customFields.region': 'REQUIRED' });
      expect((await as(owner).patch(`/contacts/${contact.id}`, { city: 'Pune' })).status).toBe(200);
    });

    it('never blocks quick adds, imports, leads or the public API', async () => {
      expect((await as(owner).post('/contacts', { name: 'Quick Add', phone: '9000011111' })).status).toBe(201);
      expect((await as(owner).post('/leads', { contact: { name: 'Lead Person', phone: '9000011112' }, title: 'Enquiry' })).status).toBe(201);

      const imported = await api().post('/api/v1/contacts/import').set(bearer(owner.token))
        .attach('file', Buffer.from('Name,Mobile\nImported One,9000011113\n', 'utf8'), 'customers.csv')
        .field('mapping', JSON.stringify(['name', 'phone']));
      expect(imported.status).toBe(200);
      expect(imported.body.data.created).toBe(1);

      const key = (await as(owner).post('/api-keys', { name: 'Zapier', scopes: ['contacts:write'] })).body.data.key;
      // Since 1B (D74) the public API saves custom fields too, and a required one never stops it.
      const viaApi = await api().post('/api/public/v1/contacts').set('Authorization', `Bearer ${key}`).send({ name: 'API Person', customFields: { machine_model: 'From API' } });
      expect(viaApi.status).toBe(201);
      expect((await Contact.findById(viaApi.body.data.id)).customFields).toEqual({ machine_model: 'From API' });
    });
  });

  describe('Values on leads and deals', () => {
    it('saves lead fields, keeps them through a stage change, and checks them', async () => {
      const stageField = (await as(owner).post('/custom-fields', { object: 'lead', label: 'Tender number', type: 'text' })).body.data;
      await as(owner).post('/custom-fields', { object: 'lead', label: 'Machines', type: 'number' });
      const lead = await as(owner).post('/leads', { contact: { name: 'Deal Buyer', phone: '9000022221' }, title: 'Big order', customFields: { tender_number: 'T-77', machines: 4 } });
      expect(lead.status).toBe(201);
      expect(lead.body.data.customFields).toEqual({ tender_number: 'T-77', machines: 4 });

      const moved = await as(owner).post(`/leads/${lead.body.data.id}/stage`, { stage: 'Negotiation' });
      expect(moved.body.data.customFields).toEqual({ tender_number: 'T-77', machines: 4 });
      const edited = await as(owner).patch(`/leads/${lead.body.data.id}`, { customFields: { machines: 6 }, version: moved.body.data.version });
      expect(edited.body.data.customFields).toEqual({ tender_number: 'T-77', machines: 6 });
      expect(codes(await as(owner).patch(`/leads/${lead.body.data.id}`, { customFields: { machines: 'six' } }))).toEqual({ 'customFields.machines': 'INVALID_TYPE' });
      // A contact field is not a lead field.
      expect(codes(await as(owner).patch(`/leads/${lead.body.data.id}`, { customFields: { machine_model: 'X' } }))).toEqual({ 'customFields.machine_model': 'UNKNOWN_FIELD' });
      const listed = (await as(owner).get('/leads?q=Deal Buyer')).body.data[0];
      expect(listed.customFields.tender_number).toBe('T-77');
      expect(stageField.object).toBe('lead');
    });
  });

  describe('Another company', () => {
    it('sees none of the fields and cannot use, change or restore them', async () => {
      expect((await as(other).get('/custom-fields?object=contact')).body.data).toEqual([]);
      expect((await as(other).get('/custom-fields?object=contact&status=all')).body.data).toEqual([]);
      expect((await as(other).patch(`/custom-fields/${fields.model.id}`, { label: 'Mine' })).status).toBe(404);
      expect((await as(other).post(`/custom-fields/${fields.model.id}/archive`)).status).toBe(404);
      expect((await as(other).post(`/custom-fields/${fields.model.id}/restore`)).status).toBe(404);
      expect((await as(other).post('/custom-fields/reorder', { object: 'contact', ids: [fields.model.id] })).status).toBe(400);
      const res = await as(other).post('/contacts', { name: 'Other Co', customFields: { machine_model: 'X' } });
      expect(codes(res)).toEqual({ 'customFields.machine_model': 'UNKNOWN_FIELD' });
      expect((await CustomFieldDefinition.findById(fields.model.id)).label).toBe('Machine model');
    });
  });

  describe('The limit', () => {
    it(`allows ${MAX_ACTIVE_FIELDS} active fields per object, archived ones not counted, also in parallel`, async () => {
      const boss = await login('cf-limit@example.com');
      const first = (await as(boss).post('/custom-fields', { object: 'contact', label: 'Field 1', type: 'text' })).body.data;
      const { organizationId } = await CustomFieldDefinition.findById(first.id);
      await CustomFieldDefinition.insertMany(Array.from({ length: MAX_ACTIVE_FIELDS - 2 }, (_, i) => ({
        organizationId, object: 'contact', key: `bulk_${i}`, label: `Bulk ${i}`, type: 'text', order: i + 1,
      })));
      const archivedOne = (await as(boss).post('/custom-fields', { object: 'contact', label: 'Old one', type: 'text' })).body.data;
      await as(boss).post(`/custom-fields/${archivedOne.id}/archive`);

      // 49 active: three admins add one each at the same moment; one of them gets the last place.
      const results = await Promise.all(['A', 'B', 'C'].map((label) => as(boss).post('/custom-fields', { object: 'contact', label, type: 'text' })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 422, 422]);
      expect(results.find((r) => r.status === 422).body.code).toBe('FIELD_LIMIT');
      expect(await CustomFieldDefinition.countDocuments({ organizationId, object: 'contact', status: 'active' })).toBe(MAX_ACTIVE_FIELDS);

      expect((await as(boss).post(`/custom-fields/${archivedOne.id}/restore`)).body.code).toBe('FIELD_LIMIT');
      // Leads have their own 50.
      expect((await as(boss).post('/custom-fields', { object: 'lead', label: 'Lead one', type: 'text' })).status).toBe(201);
    });
  });

  describe('Export and audit', () => {
    it('the full export has the fields and the values', async () => {
      const res = await api().get('/api/v1/exports/crm').set(bearer(owner.token));
      expect(res.status).toBe(200);
      expect(res.body.customFields.map((f) => f.key)).toEqual(expect.arrayContaining(['machine_model', 'dealer_type', 'tender_number']));
      expect(res.body.customFields[0].organizationId).toBeUndefined();
      expect(res.body.contacts.find((c) => c.name === 'Field Traders').customFields).toMatchObject({ credit_days: 10 });
    });

    it('every change to a field is in the audit log', async () => {
      const actions = await AuditLog.distinct('action', { entityType: 'CustomFieldDefinition' });
      expect(actions.sort()).toEqual(['custom_field.archived', 'custom_field.created', 'custom_field.reordered', 'custom_field.restored', 'custom_field.updated']);
    });
  });
});
