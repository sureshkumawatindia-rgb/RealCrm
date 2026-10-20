jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const AuditLog = require('../models/AuditLog');
const CustomFieldDefinition = require('../models/CustomFieldDefinition');
const { MAX_SECTIONS } = require('../constants/customFields');
const { HIDEABLE_MODULES } = require('../constants/permissions');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 1D (D76): sections that group a page's custom fields, and the pages a company uses.
const as = (user) => ({
  get: (url) => api().get(`/api/v1${url}`).set(bearer(user.token)),
  post: (url, body) => api().post(`/api/v1${url}`).set(bearer(user.token)).send(body),
  patch: (url, body) => api().patch(`/api/v1${url}`).set(bearer(user.token)).send(body),
  put: (url, body) => api().put(`/api/v1${url}`).set(bearer(user.token)).send(body),
});
const codes = (res) => Object.fromEntries((res.body.errors || []).map((e) => [e.field, e.code]));
const sectionOf = async (user, object) => Object.fromEntries((await as(user).get(`/custom-fields?object=${object}&status=all`)).body.data.map((f) => [f.label, f.sectionId]));

describe('Field sections and the company menu', () => {
  let owner;
  let admin;
  let agent;
  let viewer;
  let inboxOnly;
  let other;
  const fields = {};

  beforeAll(async () => {
    owner = await login('fl-owner@example.com');
    admin = await inviteAndJoin(owner.token, 'fl-admin@example.com', { role: 'admin' });
    agent = await inviteAndJoin(owner.token, 'fl-agent@example.com', { role: 'agent' });
    viewer = await inviteAndJoin(owner.token, 'fl-viewer@example.com', { role: 'viewer' });
    inboxOnly = await inviteAndJoin(owner.token, 'fl-inbox@example.com', { role: 'agent', modules: ['inbox'] });
    other = await login('fl-other@example.com');
    for (const label of ['Machine model', 'Serial number', 'Install date', 'Warranty till', 'Service plan', 'Notes for engineer']) {
      fields[label] = (await as(owner).post('/custom-fields', { object: 'contact', label, type: 'text' })).body.data;
    }
  });

  describe('Sections', () => {
    it('start empty; everyone who can view the page reads them', async () => {
      const res = await as(agent).get('/custom-fields/layout?object=contact');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ object: 'contact', sections: [], version: 0 });
      expect((await as(viewer).get('/custom-fields/layout?object=lead')).status).toBe(200);
      expect((await as(inboxOnly).get('/custom-fields/layout?object=contact')).status).toBe(403);
      expect((await as(owner).get('/custom-fields/layout?object=account')).status).toBe(400);
      expect((await as(owner).get('/custom-fields/layout?object=x_nothing')).status).toBe(404);
    });

    it('owners and admins make them, with fields, in one save; agents and viewers cannot', async () => {
      const body = {
        object: 'contact',
        version: 0,
        sections: [
          { label: 'Machine details', columns: 2, fieldIds: [fields['Machine model'].id, fields['Serial number'].id, fields['Install date'].id, fields['Warranty till'].id] },
          { label: 'Service', fieldIds: [fields['Service plan'].id] },
        ],
      };
      for (const user of [agent, viewer]) expect((await as(user).put('/custom-fields/layout', body)).status).toBe(403);
      const res = await as(owner).put('/custom-fields/layout', body);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        object: 'contact',
        version: 1,
        sections: [{ id: 's1', label: 'Machine details', columns: 2 }, { id: 's2', label: 'Service', columns: 1 }],
      });
      expect(await sectionOf(owner, 'contact')).toEqual({
        'Machine model': 's1', 'Serial number': 's1', 'Install date': 's1', 'Warranty till': 's1', 'Service plan': 's2', 'Notes for engineer': null,
      });
      expect((await as(agent).get('/custom-fields/layout?object=contact')).body.data.sections).toHaveLength(2);
      expect(await AuditLog.exists({ action: 'custom_field.layout_updated' })).toBeTruthy();
    });

    it('rename, reorder and columns keep the ids and the fields; a stale version gets 409', async () => {
      const res = await as(admin).put('/custom-fields/layout', {
        object: 'contact', version: 1, sections: [{ id: 's2', label: 'Service & AMC', columns: 2 }, { id: 's1', label: 'Machine', columns: 1 }],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.sections).toEqual([{ id: 's2', label: 'Service & AMC', columns: 2 }, { id: 's1', label: 'Machine', columns: 1 }]);
      expect((await sectionOf(owner, 'contact'))['Serial number']).toBe('s1');
      const late = await as(owner).put('/custom-fields/layout', { object: 'contact', version: 1, sections: [] });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('VERSION_CONFLICT');
    });

    it('refuses unknown or repeated sections and fields, and more than the limit', async () => {
      const put = (sections) => as(owner).put('/custom-fields/layout', { object: 'contact', sections });
      expect(codes(await put([{ id: 's9', label: 'Ghost' }]))).toEqual({ sections: 'INVALID_SECTION' });
      expect(codes(await put([{ id: 's1', label: 'A' }, { id: 's1', label: 'B' }]))).toEqual({ sections: 'INVALID_SECTION' });
      const twice = [{ id: 's1', label: 'A', fieldIds: [fields['Service plan'].id] }, { id: 's2', label: 'B', fieldIds: [fields['Service plan'].id] }];
      expect(codes(await put(twice))).toEqual({ sections: 'INVALID_SECTION' });
      const lead = (await as(owner).post('/custom-fields', { object: 'lead', label: 'Budget', type: 'number' })).body.data;
      expect(codes(await put([{ id: 's1', label: 'A', fieldIds: [lead.id] }]))).toEqual({ sections: 'INVALID_SECTION' });
      const tooMany = await put(Array.from({ length: MAX_SECTIONS + 1 }, (_, i) => ({ label: `S${i}` })));
      expect(tooMany.status).toBe(422);
      expect(tooMany.body.code).toBe('SECTION_LIMIT');
      expect((await put([{ label: 'x'.repeat(41) }])).status).toBe(400);
      expect((await put([{ label: 'Three', columns: 3 }])).status).toBe(400);
      // Nothing changed by the refused saves.
      expect((await as(owner).get('/custom-fields/layout?object=contact')).body.data.version).toBe(2);
    });

    it('a field is put in a section when added or edited; an unknown section is refused', async () => {
      const made = await as(owner).post('/custom-fields', { object: 'contact', label: 'Engineer', type: 'text', sectionId: 's2' });
      expect(made.status).toBe(201);
      expect(made.body.data.sectionId).toBe('s2');
      fields.Engineer = made.body.data;
      expect(codes(await as(owner).post('/custom-fields', { object: 'contact', label: 'Bad', type: 'text', sectionId: 's7' }))).toEqual({ sectionId: 'INVALID_SECTION' });
      expect((await as(owner).post('/custom-fields', { object: 'contact', label: 'Bad', type: 'text', sectionId: 'main' })).status).toBe(400);
      // s1 is the contact page's, not the lead page's.
      expect(codes(await as(owner).post('/custom-fields', { object: 'lead', label: 'Bad', type: 'text', sectionId: 's1' }))).toEqual({ sectionId: 'INVALID_SECTION' });

      const moved = await as(owner).patch(`/custom-fields/${fields['Notes for engineer'].id}`, { sectionId: 's2' });
      expect(moved.body.data.sectionId).toBe('s2');
      const back = await as(owner).patch(`/custom-fields/${fields['Notes for engineer'].id}`, { sectionId: null });
      expect(back.body.data.sectionId).toBeNull();
      expect(await CustomFieldDefinition.exists({ _id: fields['Notes for engineer'].id, sectionId: { $exists: true } })).toBeNull();
      expect(codes(await as(owner).patch(`/custom-fields/${fields['Notes for engineer'].id}`, { sectionId: 's5' }))).toEqual({ sectionId: 'INVALID_SECTION' });
      expect((await as(agent).patch(`/custom-fields/${fields['Notes for engineer'].id}`, { sectionId: 's1' })).status).toBe(403);
    });

    it('removing a section moves its fields to "More details"; no field is lost', async () => {
      await as(owner).post(`/custom-fields/${fields['Warranty till'].id}/archive`);
      const before = await CustomFieldDefinition.countDocuments({ object: 'contact', organizationId: (await CustomFieldDefinition.findById(fields.Engineer.id)).organizationId });
      const res = await as(owner).put('/custom-fields/layout', { object: 'contact', sections: [{ id: 's2', label: 'Service & AMC', columns: 2 }] });
      expect(res.status).toBe(200);
      const now = await sectionOf(owner, 'contact');
      expect(now).toMatchObject({ 'Machine model': null, 'Serial number': null, 'Install date': null, 'Warranty till': null, 'Service plan': 's2', Engineer: 's2' });
      expect(Object.keys(now)).toHaveLength(before);
      // An archived field restored after its section went comes back under "More details".
      expect((await as(owner).post(`/custom-fields/${fields['Warranty till'].id}/restore`)).body.data.sectionId).toBeNull();
      // A removed section's id is never given again.
      const added = await as(owner).put('/custom-fields/layout', { object: 'contact', sections: [{ id: 's2', label: 'Service & AMC' }, { label: 'Payment' }] });
      expect(added.body.data.sections.map((s) => s.id)).toEqual(['s2', 's3']);
    });

    it('an archived field keeps its section while the section exists', async () => {
      await as(owner).post(`/custom-fields/${fields.Engineer.id}/archive`);
      await as(owner).put('/custom-fields/layout', { object: 'contact', sections: [{ id: 's2', label: 'Service & AMC', fieldIds: [fields['Service plan'].id] }, { id: 's3', label: 'Payment' }] });
      const restored = await as(owner).post(`/custom-fields/${fields.Engineer.id}/restore`);
      expect(restored.body.data.sectionId).toBe('s2');
    });

    it("works for a company's own objects, only while the object is active for non-managers", async () => {
      const machines = (await as(owner).post('/custom-objects', { singular: 'Machine', plural: 'Machines' })).body.data;
      const res = await as(owner).put('/custom-fields/layout', { object: machines.key, sections: [{ label: 'Specs', columns: 2 }] });
      expect(res.status).toBe(200);
      expect((await as(agent).get(`/custom-fields/layout?object=${machines.key}`)).body.data.sections).toEqual([{ id: 's1', label: 'Specs', columns: 2 }]);
      await as(owner).post(`/custom-objects/${machines.id}/archive`);
      expect((await as(agent).get(`/custom-fields/layout?object=${machines.key}`)).status).toBe(404);
      expect((await as(owner).get(`/custom-fields/layout?object=${machines.key}`)).status).toBe(200);
    });

    it("another company never sees or changes them", async () => {
      expect((await as(other).get('/custom-fields/layout?object=contact')).body.data).toEqual({ object: 'contact', sections: [], version: 0 });
      expect(codes(await as(other).put('/custom-fields/layout', { object: 'contact', sections: [{ id: 's2', label: 'Taken' }] }))).toEqual({ sections: 'INVALID_SECTION' });
      expect(codes(await as(other).put('/custom-fields/layout', { object: 'contact', sections: [{ label: 'Mine', fieldIds: [fields['Service plan'].id] }] }))).toEqual({ sections: 'INVALID_SECTION' });
      const mine = await as(other).put('/custom-fields/layout', { object: 'contact', sections: [{ label: 'Mine' }] });
      expect(mine.body.data.sections).toEqual([{ id: 's1', label: 'Mine', columns: 1 }]);
      expect((await as(owner).get('/custom-fields/layout?object=contact')).body.data.sections.map((s) => s.label)).toEqual(['Service & AMC', 'Payment']);
      expect((await as(other).patch(`/custom-fields/${fields['Service plan'].id}`, { sectionId: 's1' })).status).toBe(404);
    });

    it('two admins making the first sections at once: one wins, the other reloads', async () => {
      const boss = await login('fl-race@example.com');
      const results = await Promise.all(['A', 'B'].map((label) => as(boss).put('/custom-fields/layout', { object: 'lead', version: 0, sections: [{ label }] })));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('the full export has the sections', async () => {
      const res = await api().get('/api/v1/exports/crm').set(bearer(owner.token));
      expect(res.status).toBe(200);
      expect(res.body.customFieldLayouts.find((l) => l.object === 'contact').sections.map((s) => s.label)).toEqual(['Service & AMC', 'Payment']);
    });
  });

  describe('Pages the company uses', () => {
    beforeAll(async () => {
      await as(owner).post('/tasks', { title: 'Visit Jodhpur plant' });
      await as(owner).post('/leads', { contact: { name: 'Jodhpur Mills', phone: '98290 41111' }, title: 'Jodhpur dyeing unit' });
    });
    const groups = async (user) => (await as(user).get('/search?q=Jodhpur')).body.data.groups;

    it('every page is used until someone switches one off', async () => {
      expect((await as(agent).get('/organization/settings')).body.data.hiddenModules).toEqual([]);
      expect((await as(agent).get('/auth/me')).body.data.organization.hiddenModules).toEqual([]);
      expect((await groups(owner)).map((g) => g.type)).toEqual(expect.arrayContaining(['tasks', 'leads']));
    });

    it('owners and admins switch pages off; Dashboard, Customers and Settings always stay', async () => {
      expect((await as(agent).patch('/organization/settings', { hiddenModules: ['tasks'] })).status).toBe(403);
      for (const module of ['dashboard', 'customers', 'settings', 'nothing']) {
        expect((await as(owner).patch('/organization/settings', { hiddenModules: [module] })).status).toBe(400);
      }
      expect((await as(owner).patch('/organization/settings', { hiddenModules: ['tasks', 'tasks'] })).status).toBe(400);
      const res = await as(admin).patch('/organization/settings', { hiddenModules: ['support', 'tasks', 'marketing'] });
      expect(res.status).toBe(200);
      // Kept in the menu's order.
      expect(res.body.data).toMatchObject({ hiddenModules: ['tasks', 'marketing', 'support'], hidePhonesFromAgents: true, sendReadReceipts: true });
      expect(await AuditLog.exists({ action: 'organization.settings_updated', 'changes.hiddenModules': 'tasks' })).toBeTruthy();
    });

    it('a switched-off page leaves everyone’s menu and search, owners too; its data stays', async () => {
      expect((await as(viewer).get('/auth/me')).body.data.organization.hiddenModules).toEqual(['tasks', 'marketing', 'support']);
      for (const user of [owner, agent]) expect((await groups(user)).map((g) => g.type)).not.toContain('tasks');
      // Not a permission (decision 2): the page's data still opens for members with access.
      const tasks = await as(owner).get('/tasks');
      expect(tasks.status).toBe(200);
      expect(tasks.body.data.map((t) => t.title)).toContain('Visit Jodhpur plant');
    });

    it('with Leads off, leads are found through the Deals page; with both off, not at all', async () => {
      await as(owner).patch('/organization/settings', { hiddenModules: ['leads'] });
      const leads = (await groups(owner)).find((g) => g.type === 'leads');
      expect(leads.allUrl).toMatch(/^Deals\.html/);
      expect(leads.items[0].url).toMatch(/^Deals\.html\?open=/);
      await as(owner).patch('/organization/settings', { hiddenModules: ['leads', 'deals'] });
      expect((await groups(owner)).map((g) => g.type)).toEqual(expect.not.arrayContaining(['leads', 'quotations', 'orders']));
    });

    it('switching a page on brings it back; another company is not touched', async () => {
      expect((await as(other).get('/organization/settings')).body.data.hiddenModules).toEqual([]);
      const res = await as(owner).patch('/organization/settings', { hiddenModules: [] });
      expect(res.body.data.hiddenModules).toEqual([]);
      expect((await groups(owner)).map((g) => g.type)).toEqual(expect.arrayContaining(['tasks', 'leads']));
      // Every page that can be switched off, at once.
      expect((await as(owner).patch('/organization/settings', { hiddenModules: HIDEABLE_MODULES })).body.data.hiddenModules).toEqual(HIDEABLE_MODULES);
      await as(owner).patch('/organization/settings', { hiddenModules: [] });
    });
  });
});
