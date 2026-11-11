jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Contact = require('../models/Contact');
const CustomFieldDefinition = require('../models/CustomFieldDefinition');
const customFieldFilters = require('../services/customFieldFilters');
const webhooks = require('../services/outboundWebhookService');
const { MAX_LIST_COLUMNS } = require('../constants/customFields');
const { FIELDS, RECORDS, CASES } = require('./helpers/customFieldFilterCases');
const { api, bearer, loginWithApi: login, inviteAndJoin } = require('./helpers/api'); // companies on Scale: the API needs it (D125)

// Phase 1B (D74): the company's own fields in list filters, list columns, CSV import, the public
// API, webhooks and search.
const as = (user) => ({
  get: (url) => api().get(`/api/v1${url}`).set(bearer(user.token)),
  post: (url, body) => api().post(`/api/v1${url}`).set(bearer(user.token)).send(body),
  patch: (url, body) => api().patch(`/api/v1${url}`).set(bearer(user.token)).send(body),
});
const pub = (key) => ({
  get: (url) => api().get(`/api/public/v1${url}`).set('Authorization', `Bearer ${key}`),
  post: (url, body) => api().post(`/api/public/v1${url}`).set('Authorization', `Bearer ${key}`).send(body),
  patch: (url, body) => api().patch(`/api/public/v1${url}`).set('Authorization', `Bearer ${key}`).send(body),
});
const names = (res) => res.body.data.map((c) => c.name).sort();
const casesOf = (res) => names(res).map((name) => name.replace('Case ', ''));
const upload = (user, csv, fields = {}) => {
  const req = api().post('/api/v1/contacts/import').set(bearer(user.token)).attach('file', Buffer.from(csv, 'utf8'), 'customers.csv');
  for (const [key, value] of Object.entries(fields)) req.field(key, typeof value === 'string' ? value : JSON.stringify(value));
  return req;
};

describe('Custom fields in lists, import, the API and search', () => {
  let owner;
  let agent;
  let other;
  let organizationId;
  const ids = {};

  beforeAll(async () => {
    owner = await login('cfl-owner@example.com');
    agent = await inviteAndJoin(owner.token, 'cfl-agent@example.com', { role: 'agent' });
    other = await login('cfl-other@example.com');
    for (const field of FIELDS) {
      const res = await as(owner).post('/custom-fields', { object: 'contact', ...field });
      expect(res.status).toBe(201);
      ids[res.body.data.key] = res.body.data.id;
    }
    ({ organizationId } = await CustomFieldDefinition.findById(ids.model));
    for (const [name, customFields] of Object.entries(RECORDS)) {
      const res = await as(owner).post('/contacts', { name: `Case ${name}`, lifecycle: 'customer', tags: ['cases'], customFields });
      expect(res.status).toBe(201);
    }
  });

  describe('Filters', () => {
    it.each(CASES)('cf=%s finds %j', async (filter, expected) => {
      const res = await as(owner).get(`/contacts?tag=cases&cf=${encodeURIComponent(filter)}`);
      expect(res.status).toBe(200);
      expect(casesOf(res)).toEqual(expected);
    });

    it('all filters must match, together with the search', async () => {
      const res = await as(owner).get(`/contacts?tag=cases&cf=${encodeURIComponent('credit:gte:30')}&cf=${encodeURIComponent('dealer:in:o1')}`);
      expect(casesOf(res)).toEqual(['B']);
      const searched = await as(owner).get(`/contacts?tag=cases&q=Case&cf=${encodeURIComponent('gst:yes')}`);
      expect(casesOf(searched)).toEqual(['A']);
    });

    it('refuses filters it cannot run', async () => {
      await as(owner).post('/custom-fields', { object: 'contact', label: 'Old field', type: 'text' })
        .then((res) => as(owner).post(`/custom-fields/${res.body.data.id}/archive`));
      for (const filter of ['nope:has:x', 'old_field:has:x', 'credit:has:5', 'credit:gt:many', 'visit:after:20/10/2026', 'dealer:in:o9', 'model:has:', 'gst:maybe']) {
        const res = await as(owner).get(`/contacts?cf=${encodeURIComponent(filter)}`);
        expect({ filter, status: res.status, code: res.body.errors?.[0]?.code }).toEqual({ filter, status: 400, code: 'INVALID_FILTER' });
      }
      const six = Array.from({ length: 6 }, () => `cf=${encodeURIComponent('gst:yes')}`).join('&');
      expect((await as(owner).get(`/contacts?${six}`)).status).toBe(400);
    });

    it("never shows another company's records, nor lets it use the fields", async () => {
      const res = await as(other).get(`/contacts?cf=${encodeURIComponent('credit:gte:0')}`);
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('INVALID_FILTER');
    });

    it('agents filter only the customers they may see', async () => {
      await as(agent).post('/contacts', { name: 'Agent Case', lifecycle: 'customer', customFields: { credit: 30 } });
      expect(names(await as(agent).get(`/contacts?cf=${encodeURIComponent('credit:eq:30')}`))).toEqual(['Agent Case']);
      expect(names(await as(owner).get(`/contacts?cf=${encodeURIComponent('credit:eq:30')}`))).toEqual(['Agent Case', 'Case A']);
    });

    it('filters leads by their own fields', async () => {
      await as(owner).post('/custom-fields', { object: 'lead', label: 'Tender', type: 'text' });
      await as(owner).post('/custom-fields', { object: 'lead', label: 'Priority', type: 'dropdown', options: [{ label: 'High' }, { label: 'Low' }] });
      await as(owner).post('/leads', { contact: { name: 'Lead One', phone: '9333300001' }, customFields: { tender: 'T-9', priority: 'o1' } });
      await as(owner).post('/leads', { contact: { name: 'Lead Two', phone: '9333300002' }, customFields: { priority: 'o2' } });
      const res = await as(owner).get(`/leads?cf=${encodeURIComponent('priority:in:o1')}`);
      expect(res.body.data.map((l) => l.contact.name)).toEqual(['Lead One']);
      expect((await as(owner).get(`/leads?cf=${encodeURIComponent('tender:empty')}`)).body.data.map((l) => l.contact.name)).toEqual(['Lead Two']);
      // A contact's field is not a lead's.
      expect((await as(owner).get(`/leads?cf=${encodeURIComponent('model:filled')}`)).body.errors[0].code).toBe('INVALID_FILTER');
    });

    it('has an index for the filters on MongoDB 7.0 and newer, which the planner can use', async () => {
      expect(await customFieldFilters.ensureValueIndexes()).toBe(true);
      const indexes = await Contact.collection.indexes();
      expect(indexes.map((i) => i.name)).toContain('organizationId_1_customFields_wildcard');
      // In the winning plan or among the plans tried (with a handful of test records either may win).
      const plan = await Contact.find({ organizationId, 'customFields.credit': { $gte: 30 } }).explain('queryPlanner');
      expect(JSON.stringify(plan)).toContain('organizationId_1_customFields_wildcard');
    });
  });

  describe('The page filter in the browser', () => {
    // crm/frontend/js/custom-fields.js, loaded as the pages load it (a classic script).
    const code = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'crm', 'frontend', 'js', 'custom-fields.js'), 'utf8');
    const sandbox = { crmApi: async () => [], t: (key) => key, escapeHtml: (s) => String(s), getPreference: () => null, setPreference: () => {} };
    vm.createContext(sandbox);
    vm.runInContext(`${code}\n;this.cfMatches = cfMatches;`, sandbox);
    const fields = FIELDS.map((field) => ({
      ...field,
      key: field.label.toLowerCase(),
      options: (field.options || []).map((o, i) => ({ value: `o${i + 1}`, label: o.label, archived: false })),
    }));

    it.each(CASES)('cf=%s finds %j, the same as the server', (filter, expected) => {
      const [key, operator, ...rest] = filter.split(':');
      const field = fields.find((f) => f.key === key);
      const found = Object.entries(RECORDS).filter(([, values]) => sandbox.cfMatches(field, values[key], operator, rest.join(':'))).map(([name]) => name);
      expect(found.sort()).toEqual(expected);
    });
  });

  describe('Search', () => {
    it('finds customers by a custom text value and by a dropdown choice name', async () => {
      expect(casesOf(await as(owner).get('/contacts?tag=cases&q=gate 2'))).toEqual(['A']);
      expect(casesOf(await as(owner).get('/contacts?tag=cases&q=wholesale'))).toEqual(['A']);
      expect(casesOf(await as(owner).get('/contacts?tag=cases&q=distrib'))).toEqual(['C']);
      // Numbers and dates are not searched.
      expect(casesOf(await as(owner).get('/contacts?tag=cases&q=45.5'))).toEqual([]);
      const global = await as(owner).get(`/search?q=${encodeURIComponent('Ask for Ravi')}`);
      const customers = global.body.data.groups.find((g) => g.type === 'customers');
      expect(customers.items.map((i) => i.title)).toEqual(['Case C']);
    });

    it("finds leads by their own fields and by their contact's", async () => {
      expect((await as(owner).get('/leads?q=T-9')).body.data.map((l) => l.contact.name)).toEqual(['Lead One']);
      await as(owner).post('/leads', { contactId: (await Contact.findOne({ name: 'Case A' }))._id, title: 'Repeat order' });
      expect((await as(owner).get('/leads?q=CNC-200')).body.data.map((l) => l.title)).toEqual(['Repeat order']);
    });
  });

  describe('List columns', () => {
    it(`allows ${MAX_LIST_COLUMNS} columns per object, archived fields not counted`, async () => {
      for (const key of ['model', 'credit', 'dealer']) expect((await as(owner).patch(`/custom-fields/${ids[key]}`, { listColumn: true })).status).toBe(200);
      const fourth = await as(owner).patch(`/custom-fields/${ids.visit}`, { listColumn: true });
      expect(fourth.status).toBe(422);
      expect(fourth.body.code).toBe('COLUMN_LIMIT');
      const created = await as(owner).post('/custom-fields', { object: 'contact', label: 'Fourth column', type: 'text', listColumn: true });
      expect(created.body.code).toBe('COLUMN_LIMIT');
      // Leads have their own three.
      expect((await as(owner).post('/custom-fields', { object: 'lead', label: 'Lead column', type: 'text', listColumn: true })).status).toBe(201);

      await as(owner).post(`/custom-fields/${ids.credit}/archive`);
      expect((await as(owner).patch(`/custom-fields/${ids.visit}`, { listColumn: true })).status).toBe(200);
      // Restored while all three places are taken: back as a field, not as a column.
      const restored = await as(owner).post(`/custom-fields/${ids.credit}/restore`);
      expect(restored.body.data).toMatchObject({ status: 'active', listColumn: false });
      const listed = (await as(agent).get('/custom-fields?object=contact')).body.data;
      expect(listed.filter((f) => f.listColumn).map((f) => f.key)).toEqual(['model', 'visit', 'dealer']);
    });
  });

  describe('CSV import', () => {
    const FILE = [
      'Name,Mobile,Credit,Visit,Dealer,GST,Model',
      'Import One,9111100001,"1,25,000",20/10/2026,wholesale,Yes,M-1',
      'Import Two,9111100002,"₹ 2,500",2026-11-05,Exporter,नहीं,',
      'Import Three,9111100003,abc,31/02/2026,RETAIL,maybe,M-3',
      'Import One again,9111100001,,,Retail,,M-1b',
      'Existing Person,9111100009,10,,Distributor,,New model',
    ].join('\n');
    const MAPPING = ['name', 'phone', 'cf:credit', 'cf:visit', 'cf:dealer', 'cf:gst', 'cf:model'];

    beforeAll(async () => {
      await as(owner).post('/custom-fields', { object: 'contact', label: 'Region', type: 'text', required: true });
      await as(owner).post('/contacts', { name: 'Existing Person', phone: '9111100009', customFields: { credit: 99, region: 'West' } });
    });

    it('offers the fields as targets and matches columns by name (built-in fields first)', async () => {
      const res = await api().post('/api/v1/contacts/import/preview').set(bearer(owner.token)).attach('file', Buffer.from(FILE, 'utf8'), 'customers.csv');
      expect(res.status).toBe(200);
      expect(res.body.data.mapping).toEqual(['name', 'phone', 'cf:credit', 'cf:visit', 'cf:dealer', 'gstin', 'cf:model']);
      expect(res.body.data.customFields.map((f) => f.value)).toEqual(expect.arrayContaining(['cf:model', 'cf:credit', 'cf:region']));
      expect(res.body.data.customFields.map((f) => f.value)).not.toContain('cf:old_field');
    });

    it('a dry run saves nothing', async () => {
      const res = await upload(owner, FILE, { mapping: MAPPING, dryRun: 'true' });
      expect(res.body.data).toMatchObject({ dryRun: true, created: 3, updated: 1, customLeftOut: 4 });
      expect(await Contact.countDocuments({ name: /^Import / })).toBe(0);
    });

    it('reads Indian formats, reports what it left out, and never overwrites', async () => {
      const res = await upload(owner, FILE, { mapping: MAPPING });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ created: 3, updated: 1, mergedInFile: 1, customLeftOut: 4 });
      expect(res.body.data.warnings).toEqual([
        { row: 3, text: 'Dealer: "Exporter" is not one of its choices' },
        { row: 4, text: 'Credit: "abc" is not a number we can keep' },
        { row: 4, text: 'Visit: "31/02/2026" is not a date (use 20/10/2026 or 2026-10-20)' },
        { row: 4, text: 'GST: "maybe" is not yes or no' },
      ]);
      const values = async (name) => (await Contact.findOne({ name })).customFields;
      expect(await values('Import One')).toEqual({ credit: 125000, visit: '2026-10-20', dealer: 'o2', gst: true, model: 'M-1' });
      expect(await values('Import Two')).toEqual({ credit: 2500, visit: '2026-11-05' });
      expect(await values('Import Three')).toEqual({ dealer: 'o1', model: 'M-3' });
      // Already here: the empty fields are filled, credit stays 99; the required Region never stopped a row.
      expect(await values('Existing Person')).toEqual({ credit: 99, region: 'West', dealer: 'o3', model: 'New model' });
    });

    it('refuses a column mapped to a field that is not there', async () => {
      const res = await upload(owner, FILE, { mapping: ['name', 'phone', 'cf:old_field', '', '', '', ''] });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('UNKNOWN_FIELD');
    });

    it('imports 1,000 rows: every readable value right, every unreadable one reported (scorecard 1)', async () => {
      const dealers = ['retail', 'WHOLESALE', ' Distributor '];
      const rows = ['Name,Mobile,Credit,Visit,Dealer'];
      const expected = new Map();
      let bad = 0;
      for (let i = 1; i <= 1000; i += 1) {
        const phone = `92${String(i).padStart(8, '0')}`;
        const day = (i % 28) + 1;
        const badDate = i % 25 === 0;
        const badDealer = i % 40 === 0;
        bad += Number(badDate) + Number(badDealer);
        rows.push(`Bulk ${i},${phone},"${(i * 1000).toLocaleString('en-IN')}",${badDate ? '32/10/2026' : `${day}/10/2026`},${badDealer ? 'Exporter' : dealers[i % 3]}`);
        expected.set(`+91${phone}`, {
          credit: i * 1000,
          ...(!badDate && { visit: `2026-10-${String(day).padStart(2, '0')}` }),
          ...(!badDealer && { dealer: `o${(i % 3) + 1}` }),
        });
      }
      const res = await upload(owner, rows.join('\n'), { mapping: ['name', 'phone', 'cf:credit', 'cf:visit', 'cf:dealer'] });
      expect(res.body.data).toMatchObject({ created: 1000, rejected: 0, customLeftOut: bad });
      expect(res.body.data.warnings).toHaveLength(bad);
      expect(res.body.data.warnings.filter((w) => w.text.startsWith('Visit')).map((w) => w.row)).toEqual(Array.from({ length: 40 }, (_, n) => (n + 1) * 25 + 1));
      const saved = await Contact.find({ name: /^Bulk / }).select('phoneE164 customFields').lean();
      const wrong = saved.filter((c) => JSON.stringify(c.customFields) !== JSON.stringify(expected.get(c.phoneE164)));
      expect({ saved: saved.length, wrong: wrong.length }).toEqual({ saved: 1000, wrong: 0 });
    });
  });

  describe('Public API and webhooks', () => {
    let full;
    let contactsOnly;
    beforeAll(async () => {
      full = (await as(owner).post('/api-keys', { name: 'Zapier', scopes: ['contacts:read', 'contacts:write', 'leads:read'] })).body.data.key;
      contactsOnly = (await as(owner).post('/api-keys', { name: 'Sheets', scopes: ['contacts:read'] })).body.data.key;
    });

    it('lists the fields for the scopes the key has', async () => {
      const contactFields = await pub(full).get('/custom-fields?object=contact');
      expect(contactFields.status).toBe(200);
      expect(contactFields.body.data.find((f) => f.key === 'dealer')).toEqual({
        key: 'dealer', label: 'Dealer', type: 'dropdown', required: false, helpText: '',
        options: [{ value: 'o1', label: 'Retail' }, { value: 'o2', label: 'Wholesale' }, { value: 'o3', label: 'Distributor' }],
      });
      expect(contactFields.body.data.map((f) => f.key)).not.toContain('old_field');
      expect((await pub(contactsOnly).get('/custom-fields?object=lead')).body.code).toBe('SCOPE_MISSING');
      expect((await pub(full).get('/custom-fields?object=lead')).body.data.map((f) => f.key)).toEqual(expect.arrayContaining(['tender', 'priority']));
    });

    it('returns custom fields with choice names, filters by them, and writes them', async () => {
      const listed = await pub(full).get(`/contacts?search=Case&cf=${encodeURIComponent('dealer:in:o2')}&cf=${encodeURIComponent('gst:yes')}`);
      expect(listed.body.data.map((c) => c.name)).toEqual(['Case A']);
      expect(listed.body.data[0].customFields).toMatchObject({ model: 'CNC-200', credit: 30, visit: '2026-10-20', dealer: 'Wholesale', gst: true });

      const made = await pub(full).post('/contacts', { name: 'Via API', phone: '9444400001', customFields: { dealer: 'retail', credit: 12 } });
      expect(made.status).toBe(201); // Region is required, but never for the API (D73)
      expect(made.body.data.customFields).toEqual({ dealer: 'Retail', credit: 12 });
      expect((await Contact.findById(made.body.data.id)).customFields).toEqual({ dealer: 'o1', credit: 12 });
      const changed = await pub(full).patch(`/contacts/${made.body.data.id}`, { customFields: { dealer: 'o3', credit: null } });
      expect(changed.body.data.customFields).toEqual({ dealer: 'Distributor' });
      const wrong = await pub(full).post('/contacts', { name: 'Bad', customFields: { dealer: 'Exporter' } });
      expect(wrong.status).toBe(400);
      expect(wrong.body.errors[0]).toMatchObject({ field: 'customFields.dealer', code: 'INVALID_OPTION' });

      const lead = (await pub(full).get(`/leads?cf=${encodeURIComponent('priority:in:o1')}`)).body.data;
      expect(lead.map((l) => l.customFields)).toEqual([{ tender: 'T-9', priority: 'High' }]);
    });

    it("never shows another company's records", async () => {
      const stranger = (await as(other).post('/api-keys', { name: 'Theirs', scopes: ['contacts:read', 'leads:read'] })).body.data.key;
      expect((await pub(stranger).get('/custom-fields?object=contact')).body.data).toEqual([]);
      expect((await pub(stranger).get(`/contacts?cf=${encodeURIComponent('dealer:in:o2')}`)).body.errors[0].code).toBe('INVALID_FILTER');
      const caseA = await Contact.findOne({ name: 'Case A' });
      expect((await pub(stranger).get(`/contacts/${caseA._id}`)).status).toBe(404);
    });

    it('webhooks carry the custom fields of the contact and the lead', async () => {
      const lead = (await as(owner).get('/leads?q=T-9')).body.data[0];
      const data = await webhooks.dataOf({ type: 'lead.created', organizationId, leadId: lead.id });
      expect(data.lead.customFields).toEqual({ tender: 'T-9', priority: 'High' });
      const caseA = await Contact.findOne({ name: 'Case A' });
      const contactData = await webhooks.dataOf({ type: 'contact.created', organizationId, contactId: caseA._id });
      expect(contactData.contact.customFields).toMatchObject({ model: 'CNC-200', dealer: 'Wholesale' });
    });
  });
});
