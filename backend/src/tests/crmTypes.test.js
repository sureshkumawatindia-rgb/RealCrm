jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const fs = require('fs');
const path = require('path');
const AuditLog = require('../models/AuditLog');
const Organization = require('../models/Organization');
const { CRM_TYPE_IDS, CRM_TYPE_SETUPS } = require('../constants/crmTypes');
const pestControl = require('../constants/crmTypeSetups/pestControl');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// CRM types (docs/CRM_TYPES_PLAN.md): a company chooses its kind of CRM on the company form. Every
// company is a Business until it chooses, and only owners and admins can change it.
const organization = (person) => api().get('/api/v1/organization').set(bearer(person.token));
const change = (person, body) => api().patch('/api/v1/organization').set(bearer(person.token)).send(body);
const read = async (person, path) => (await api().get(`/api/v1${path}`).set(bearer(person.token))).body.data;
const send = (person, method, path, body) => api()[method](`/api/v1${path}`).set(bearer(person.token)).send(body);
const stagesOf = async (person) => (await read(person, '/pipelines')).find((pipeline) => pipeline.isDefault).stages.map((stage) => stage.name);
const listOf = (data) => data.items || data;
const productsOf = async (person) => listOf(await read(person, '/products?limit=100'));
const hiddenPages = async (person) => (await read(person, '/organization/settings')).hiddenModules;
const leadFields = async (person) => read(person, '/custom-fields?object=lead');
const replies = async (person) => read(person, '/quick-replies');
const objects = async (person) => read(person, '/custom-objects');

describe('CRM type', () => {
  it('starts as Business, also for a company from before CRM types', async () => {
    const owner = await login('crmtype-new@example.com');
    expect((await organization(owner)).body.data.crmType).toBe('business');

    const { id } = (await organization(owner)).body.data;
    await Organization.updateOne({ _id: id }, { $unset: { crmType: '' } });
    expect(await Organization.exists({ _id: id, crmType: { $exists: false } })).toBeTruthy();
    expect((await organization(owner)).body.data.crmType).toBe('business');
  });

  it('an owner chooses Pest Control, and the change is written in the audit log', async () => {
    const owner = await login('crmtype-owner@example.com');
    const res = await change(owner, { crmType: 'pest_control' });
    expect(res.status).toBe(200);
    expect(res.body.data.crmType).toBe('pest_control');
    expect((await organization(owner)).body.data.crmType).toBe('pest_control');
    expect(await AuditLog.exists({ action: 'organization.updated', 'changes.crmType': 'pest_control' })).toBeTruthy();
  });

  it('saving other company details leaves the CRM type as it is', async () => {
    const owner = await login('crmtype-keep@example.com');
    await change(owner, { crmType: 'pest_control' });
    expect((await change(owner, { city: 'Indore' })).body.data.crmType).toBe('pest_control');
  });

  it('refuses a type that does not exist, and an empty one', async () => {
    const owner = await login('crmtype-wrong@example.com');
    expect((await change(owner, { crmType: 'space_travel' })).status).toBe(400);
    expect((await change(owner, { crmType: '' })).status).toBe(400);
    expect((await organization(owner)).body.data.crmType).toBe('business');
  });

  it('an agent cannot change it', async () => {
    const owner = await login('crmtype-boss@example.com');
    const agent = await inviteAndJoin(owner.token, 'crmtype-agent@example.com', { modules: ['inbox'] });
    expect((await change(agent, { crmType: 'pest_control' })).status).toBe(403);
    expect((await organization(owner)).body.data.crmType).toBe('business');
  });

  it('/auth/me tells every page the company\'s type', async () => {
    const owner = await login('crmtype-me@example.com');
    await change(owner, { crmType: 'pest_control' });
    expect((await read(owner, '/auth/me')).organization.crmType).toBe('pest_control');
  });

  it('the company form and Settings offer exactly the types the server accepts, named in both languages', () => {
    const frontend = path.join(__dirname, '../../../crm/frontend');
    const texts = (language) => JSON.parse(fs.readFileSync(path.join(frontend, 'i18n', `${language}.json`), 'utf8'));
    for (const page of ['company.html', 'Settings.html']) {
      const html = fs.readFileSync(path.join(frontend, page), 'utf8');
      const select = html.match(/<select id="cCrmType">([\s\S]*?)<\/select>/)[1];
      expect([...select.matchAll(/value="([^"]+)"/g)].map((match) => match[1])).toEqual([...CRM_TYPE_IDS]);
    }
    for (const language of ['en', 'hi']) {
      for (const id of CRM_TYPE_IDS) expect(texts(language)[`crmType.${id}`]).toBeTruthy();
    }
  });
});

describe('Choosing Pest Control sets the same CRM up for it', () => {
  it('fills in the stages, quick replies, terms, treatments, fields, AMC records and the menu', async () => {
    const owner = await login('pest-setup@example.com');
    expect((await change(owner, { crmType: 'pest_control' })).status).toBe(200);

    expect(await stagesOf(owner)).toEqual(['New enquiry', 'Site inspection', 'Quotation sent', 'Treatment booked']);
    expect((await replies(owner)).map((reply) => reply.shortcut)).toEqual(expect.arrayContaining(['inspection', 'precautions', 'visit', 'amc', 'renewal']));
    const billing = await read(owner, '/organization/billing');
    expect(billing.terms).toContain('Warranty');

    const list = await productsOf(owner);
    expect(list.map((one) => one.name)).toEqual(expect.arrayContaining(['Termite treatment', 'Cockroach treatment', 'Annual contract (AMC)']));
    expect(list.find((one) => one.name === 'Termite treatment')).toMatchObject({ pricePaise: 0, gstRatePct: 18, hsnSac: '998531', unit: 'sq ft' });

    const fields = await leadFields(owner);
    expect(fields.map((field) => field.label)).toEqual(['Pest type', 'Property type', 'Area (sq ft)', 'Inspection date']);
    expect(fields[0]).toMatchObject({ type: 'dropdown', listColumn: true });
    expect(fields[0].options.map((option) => option.label)).toContain('Termite');

    const [amc] = await objects(owner);
    expect(amc).toMatchObject({ singular: 'AMC contract', plural: 'AMC contracts', icon: 'file-contract' });
    const amcFields = await read(owner, `/custom-fields?object=${amc.key}`);
    expect(amcFields.map((field) => field.label)).toEqual(['Start date', 'End date', 'Visits in a year', 'Next service date', 'Contract amount (₹)', 'Status']);
    expect(amcFields.some((field) => field.type === 'lookup')).toBe(false); // a record has its own customer link

    const [amcVisits] = await read(owner, '/project-templates');
    expect(amcVisits).toMatchObject({ name: 'AMC: 4 visits a year', days: 365 });
    expect(amcVisits.milestones.map((milestone) => [milestone.name, milestone.dueAfterDays])).toEqual([
      ['First visit', 0], ['Second visit', 90], ['Third visit', 180], ['Fourth visit', 270], ['AMC renewal', 335],
    ]);
    expect(amcVisits.tasks).toHaveLength(8);

    expect(await hiddenPages(owner)).toEqual([]); // Projects carries the AMC visits
    expect((await read(owner, '/organization/getting-started')).kit).toBe('pest_control');
    expect(await AuditLog.exists({ action: 'organization.crm_type_changed', 'changes.to': 'pest_control' })).toBeTruthy();
  });

  it('a won AMC job becomes a year of visits, reminders and the renewal in one click', async () => {
    const owner = await login('pest-amc@example.com');
    await change(owner, { crmType: 'pest_control' });
    const [amcVisits] = await read(owner, '/project-templates');
    const lead = (await send(owner, 'post', '/leads', { title: 'AMC 2 BHK flat', contact: { name: 'Sharma ji', phone: '+919829080921' } })).body.data;
    await send(owner, 'post', `/leads/${lead.id}/stage`, { stage: 'Won' });
    const started = await send(owner, 'post', `/leads/${lead.id}/project`, { templateId: amcVisits.id, startDate: '2026-12-01' });
    expect(started.status).toBe(201);
    expect(started.body.data.tasks).toMatchObject({ total: 8, done: 0 });
    const tasks = listOf(await read(owner, `/projects/${started.body.data.id}/tasks`));
    const dueDays = tasks.map((task) => String(task.dueDate).slice(0, 10)).sort();
    expect(dueDays).toEqual(['2026-12-01', '2027-02-27', '2027-03-01', '2027-05-28', '2027-05-30', '2027-08-26', '2027-08-28', '2027-11-01']);
  });

  it('is in Hindi for a Hindi user', async () => {
    const owner = await login('pest-hindi@example.com');
    await send(owner, 'patch', '/auth/preferences', { language: 'hi' });
    await change(owner, { crmType: 'pest_control' });
    expect((await stagesOf(owner))[1]).toBe('साइट निरीक्षण');
    expect((await productsOf(owner)).map((one) => one.name)).toContain('दीमक ट्रीटमेंट');
    expect((await leadFields(owner))[0].label).toBe('कीट का प्रकार');
    expect((await objects(owner))[0].plural).toBe('AMC कॉन्ट्रैक्ट');
  });

  it('keeps what the company set itself', async () => {
    const owner = await login('pest-own@example.com');
    const pipeline = (await read(owner, '/pipelines')).find((one) => one.isDefault);
    const stages = pipeline.stages.map((stage) => ({ id: stage.id, name: stage.name === 'New' ? 'Fresh' : stage.name, kind: stage.kind }));
    expect((await send(owner, 'patch', `/pipelines/${pipeline.id}`, { stages })).status).toBe(200);
    await send(owner, 'post', '/quick-replies', { shortcut: 'visit', title: 'Ours', body: 'Our own words' });
    expect((await send(owner, 'put', '/organization/billing', { terms: 'Our own terms' })).status).toBe(200);
    await send(owner, 'post', '/products', { name: 'Termite treatment', unit: 'job', pricePaise: 500000, gstRatePct: 18 });
    await send(owner, 'post', '/custom-fields', { object: 'lead', label: 'Pest type', type: 'text' });

    expect((await change(owner, { crmType: 'pest_control' })).status).toBe(200);

    expect((await stagesOf(owner))[0]).toBe('Fresh');
    expect((await replies(owner)).find((reply) => reply.shortcut === 'visit').body).toBe('Our own words');
    expect((await read(owner, '/organization/billing')).terms).toBe('Our own terms');
    const termite = (await productsOf(owner)).filter((one) => one.name === 'Termite treatment');
    expect(termite).toHaveLength(1);
    expect(termite[0].pricePaise).toBe(500000);
    const pest = (await leadFields(owner)).filter((field) => field.label === 'Pest type');
    expect(pest).toHaveLength(1);
    expect(pest[0].type).toBe('text');
  });

  it('going back to Business deletes nothing, the owner\'s own hidden pages stay hidden, and choosing it again adds nothing twice', async () => {
    const owner = await login('pest-back@example.com');
    await send(owner, 'patch', '/organization/settings', { hiddenModules: ['marketing'] });
    await change(owner, { crmType: 'pest_control' });
    expect(await hiddenPages(owner)).toEqual(['marketing']);
    const treatmentCount = (await productsOf(owner)).length;

    await change(owner, { crmType: 'business' });
    expect(await hiddenPages(owner)).toEqual(['marketing']);
    expect((await productsOf(owner)).length).toBe(treatmentCount);
    expect((await leadFields(owner)).length).toBe(4);

    await change(owner, { crmType: 'pest_control' });
    expect((await productsOf(owner)).length).toBe(treatmentCount);
    expect((await leadFields(owner)).length).toBe(4);
    expect((await objects(owner)).length).toBe(1);
    expect((await read(owner, `/custom-fields?object=${(await objects(owner))[0].key}`)).length).toBe(6);
    expect(await read(owner, '/project-templates')).toHaveLength(1);
  });

  it('a Business company gets nothing added, and Ready settings still offers only its two kits', async () => {
    const owner = await login('pest-business@example.com');
    await change(owner, { crmType: 'business', city: 'Jaipur' });
    expect(await productsOf(owner)).toEqual([]);
    expect(await leadFields(owner)).toEqual([]);
    expect(await replies(owner)).toEqual([]);
    expect((await read(owner, '/organization/business-kits')).kits.map((kit) => kit.id)).toEqual(['trader', 'manufacturer']);
    expect((await send(owner, 'post', '/organization/business-kit', { kit: 'pest_control' })).status).toBe(400);
  });

  it('the set-up has no typing mistakes the CRM would refuse', () => {
    for (const reply of pestControl.kit.quickReplies) expect(reply.shortcut).toMatch(/^[a-z0-9_-]{1,30}$/);
    for (const language of ['en', 'hi']) {
      expect(pestControl.kit.terms[language].split('\n')).toHaveLength(8);
      for (const treatment of pestControl.products) expect(treatment.name[language]).toBeTruthy();
    }
  });
});

describe('Choosing Trader / Wholesaler sets the same CRM up for it', () => {
  it('uses the trader ready settings, adds customer and enquiry fields and Transporters, and hides Projects', async () => {
    const owner = await login('trader-setup@example.com');
    expect((await change(owner, { crmType: 'trader' })).status).toBe(200);

    expect(await stagesOf(owner)).toEqual(['New enquiry', 'Rate shared', 'Quotation sent', 'Negotiation']);
    expect((await replies(owner)).map((reply) => reply.shortcut)).toEqual(expect.arrayContaining(['rate', 'moq', 'payment', 'dispatch']));
    expect((await read(owner, '/organization/billing')).terms).toContain('ex-godown');
    expect(await productsOf(owner)).toEqual([]); // what a trader sells is their own

    const customerFields = await read(owner, '/custom-fields?object=contact');
    expect(customerFields.map((field) => field.label)).toEqual(['Customer type', 'Credit limit (₹)', 'Credit days', 'Area or route']);
    expect(customerFields[0]).toMatchObject({ type: 'dropdown', listColumn: true });
    expect((await leadFields(owner)).map((field) => field.label)).toEqual(['Delivery city', 'Needed by']);

    const [transporters] = await objects(owner);
    expect(transporters).toMatchObject({ singular: 'Transporter', plural: 'Transporters', icon: 'truck' });
    expect((await read(owner, `/custom-fields?object=${transporters.key}`)).map((field) => field.label)).toEqual(['Phone', 'Cities served', 'Freight rate']);

    expect(await hiddenPages(owner)).toEqual(['projects']);
    expect((await read(owner, '/organization/getting-started')).kit).toBe('trader');
  });

  it('is in Hindi for a Hindi user', async () => {
    const owner = await login('trader-hindi@example.com');
    await send(owner, 'patch', '/auth/preferences', { language: 'hi' });
    await change(owner, { crmType: 'trader' });
    expect((await stagesOf(owner))[1]).toBe('रेट भेजा');
    expect((await read(owner, '/custom-fields?object=contact'))[1].label).toBe('उधार की सीमा (₹)');
    expect((await objects(owner))[0].plural).toBe('ट्रांसपोर्टर');
  });

  it('going back to Business brings Projects back; the owner\'s own hidden pages stay hidden', async () => {
    const owner = await login('trader-back@example.com');
    await send(owner, 'patch', '/organization/settings', { hiddenModules: ['marketing'] });
    await change(owner, { crmType: 'trader' });
    expect(await hiddenPages(owner)).toEqual(['marketing', 'projects']);
    await change(owner, { crmType: 'business' });
    expect(await hiddenPages(owner)).toEqual(['marketing']);
  });

  it('a page the owner switched back on stays on when other details are saved', async () => {
    const owner = await login('trader-menu@example.com');
    await change(owner, { crmType: 'trader' });
    await send(owner, 'patch', '/organization/settings', { hiddenModules: [] });
    await change(owner, { crmType: 'trader', city: 'Indore' });
    expect(await hiddenPages(owner)).toEqual([]);
  });

  it('a pest control company that becomes a trader keeps all it had, and Projects is hidden as a trader\'s', async () => {
    const owner = await login('pest-to-trader@example.com');
    await change(owner, { crmType: 'pest_control' });
    const pestProducts = (await productsOf(owner)).length;
    expect((await change(owner, { crmType: 'trader' })).status).toBe(200);
    expect((await stagesOf(owner))[1]).toBe('Site inspection'); // its stages were set already: they stay
    expect((await productsOf(owner)).length).toBe(pestProducts);
    expect((await leadFields(owner)).map((field) => field.label)).toEqual(['Pest type', 'Property type', 'Area (sq ft)', 'Inspection date', 'Delivery city', 'Needed by']);
    expect((await objects(owner)).map((object) => object.plural)).toEqual(['AMC contracts', 'Transporters']);
    expect(await hiddenPages(owner)).toEqual(['projects']);
  });

  it('Ready settings still offers the trader kit to a Business company', async () => {
    const owner = await login('trader-kit@example.com');
    expect((await read(owner, '/organization/business-kits')).kits.map((kit) => kit.id)).toEqual(['trader', 'manufacturer']);
    expect((await send(owner, 'post', '/organization/business-kit', { kit: 'trader' })).status).toBe(200);
    expect((await organization(owner)).body.data.crmType).toBe('business');
  });
});

describe('Choosing Manufacturer sets the same CRM up for it', () => {
  const templates = (person) => read(person, '/project-templates');

  it('uses the manufacturer ready settings, adds fields, Transporters and a production template, and keeps Projects', async () => {
    const owner = await login('maker-setup@example.com');
    expect((await change(owner, { crmType: 'manufacturer' })).status).toBe(200);

    expect(await stagesOf(owner)).toEqual(['New enquiry', 'Requirement understood', 'Sample sent', 'Quotation sent', 'Waiting for PO']);
    expect((await replies(owner)).map((reply) => reply.shortcut)).toEqual(expect.arrayContaining(['catalogue', 'sample', 'leadtime', 'dispatch']));
    expect((await read(owner, '/organization/billing')).terms).toContain('ex-works');
    expect(await productsOf(owner)).toEqual([]); // what a manufacturer makes is their own

    const customerFields = await read(owner, '/custom-fields?object=contact');
    expect(customerFields.map((field) => field.label)).toEqual(['Customer type', 'Credit limit (₹)', 'Credit days']);
    expect(customerFields[0].options.map((option) => option.label)).toContain('OEM or brand');
    const enquiryFields = await leadFields(owner);
    expect(enquiryFields.map((field) => field.label)).toEqual(['Size or specification', 'Sample status', 'Needed by']);
    expect(enquiryFields[1]).toMatchObject({ type: 'dropdown', listColumn: true });

    expect((await objects(owner)).map((object) => object.plural)).toEqual(['Transporters']);
    const [production] = await templates(owner);
    expect(production).toMatchObject({ name: 'Production order', days: 21 });
    expect(production.milestones.map((milestone) => milestone.name)).toEqual(['Order confirmed', 'Raw material ready', 'Production done', 'Quality checked and packed', 'Dispatched']);
    expect(production.tasks).toHaveLength(5);

    expect(await hiddenPages(owner)).toEqual([]);
    expect((await read(owner, '/organization/getting-started')).kit).toBe('manufacturer');
  });

  it('a won enquiry becomes a production project with its steps in one click', async () => {
    const owner = await login('maker-project@example.com');
    await change(owner, { crmType: 'manufacturer' });
    const [production] = await templates(owner);
    const lead = (await send(owner, 'post', '/leads', { title: 'MS pipes 2 tonnes', contact: { name: 'Gupta Builders', phone: '+919829080911' } })).body.data;
    await send(owner, 'post', `/leads/${lead.id}/stage`, { stage: 'Won' });
    const started = await send(owner, 'post', `/leads/${lead.id}/project`, { templateId: production.id });
    expect(started.status).toBe(201);
    expect(started.body.data.milestones.map((milestone) => milestone.name)).toEqual(production.milestones.map((milestone) => milestone.name));
    expect(started.body.data.tasks).toMatchObject({ total: 5, done: 0 });
  });

  it('is in Hindi for a Hindi user', async () => {
    const owner = await login('maker-hindi@example.com');
    await send(owner, 'patch', '/auth/preferences', { language: 'hi' });
    await change(owner, { crmType: 'manufacturer' });
    expect((await stagesOf(owner))[2]).toBe('सैंपल भेजा');
    expect((await leadFields(owner))[0].label).toBe('साइज़ या स्पेसिफ़िकेशन');
    expect((await templates(owner))[0].name).toBe('प्रोडक्शन ऑर्डर');
  });

  it('a trader that becomes a manufacturer keeps its Transporters and fields once, and gets Projects back', async () => {
    const owner = await login('trader-to-maker@example.com');
    await change(owner, { crmType: 'trader' });
    expect(await hiddenPages(owner)).toEqual(['projects']);
    expect((await change(owner, { crmType: 'manufacturer' })).status).toBe(200);
    expect((await objects(owner)).map((object) => object.plural)).toEqual(['Transporters']);
    expect((await read(owner, '/custom-fields?object=contact')).map((field) => field.label)).toEqual(['Customer type', 'Credit limit (₹)', 'Credit days', 'Area or route']);
    expect((await leadFields(owner)).map((field) => field.label)).toEqual(['Delivery city', 'Needed by', 'Size or specification', 'Sample status']);
    expect(await hiddenPages(owner)).toEqual([]);
    expect(await templates(owner)).toHaveLength(1);
  });

  it('every set-up keeps to what the CRM allows', () => {
    for (const setup of Object.values(CRM_TYPE_SETUPS)) {
      for (const field of [...setup.fields, ...setup.records.flatMap((record) => record.fields)]) {
        expect(field.label.en.length).toBeLessThanOrEqual(60);
        expect(field.label.hi.length).toBeLessThanOrEqual(60);
      }
      for (const template of setup.projectTemplates || []) {
        for (const task of template.tasks) expect(task.milestone).toBeLessThan(template.milestones.length);
      }
    }
  });
});

describe('Choosing Real Estate sets the same CRM up for it', () => {
  it('adds its stages and replies, enquiry fields, Properties linked from every enquiry, and hides Projects', async () => {
    const owner = await login('estate-setup@example.com');
    expect((await change(owner, { crmType: 'real_estate' })).status).toBe(200);

    expect(await stagesOf(owner)).toEqual(['New enquiry', 'Requirement understood', 'Site visit fixed', 'Site visit done', 'Price shared', 'Negotiation']);
    expect((await replies(owner)).map((reply) => reply.shortcut)).toEqual(expect.arrayContaining(['details', 'property', 'visit', 'followup', 'documents', 'payment', 'thanks']));
    expect((await read(owner, '/organization/billing')).terms).toContain('stamp duty');
    expect(await productsOf(owner)).toEqual([]); // a quotation line can be a name and a price

    expect((await read(owner, '/custom-fields?object=contact')).map((field) => field.label)).toEqual(['Customer type']);
    const [properties] = await objects(owner);
    expect(properties).toMatchObject({ singular: 'Property', plural: 'Properties', icon: 'building' });
    const propertyFields = await read(owner, `/custom-fields?object=${properties.key}`);
    expect(propertyFields.map((field) => field.label)).toEqual(['Sale or rent', 'Property type', 'BHK', 'Area (sq ft)', 'Price (₹)', 'Location', 'Status']);
    expect(propertyFields.filter((field) => field.listColumn).map((field) => field.label)).toEqual(['Price (₹)', 'Location', 'Status']);

    const enquiryFields = await leadFields(owner);
    expect(enquiryFields.map((field) => field.label)).toEqual(['Requirement', 'Property type', 'BHK', 'Budget (₹)', 'Preferred location', 'Site visit date', 'Property']);
    expect(enquiryFields.filter((field) => field.listColumn).map((field) => field.label)).toEqual(['Requirement', 'BHK', 'Budget (₹)']);
    expect(enquiryFields[6]).toMatchObject({ type: 'lookup', lookupTarget: properties.key });

    expect(await hiddenPages(owner)).toEqual(['projects']);
    expect((await read(owner, '/organization/getting-started')).kit).toBe('real_estate');
    expect((await read(owner, '/organization/business-kits')).kits.map((kit) => kit.id)).toEqual(['trader', 'manufacturer']);
  });

  it('a property belongs to its owner, and an enquiry links the property it is about', async () => {
    const owner = await login('estate-link@example.com');
    await change(owner, { crmType: 'real_estate' });
    const [properties] = await objects(owner);
    const propertyFields = await read(owner, `/custom-fields?object=${properties.key}`);
    const byLabel = (fields, label) => fields.find((field) => field.label === label);
    const choice = (field, label) => field.options.find((option) => option.label === label).value;

    const landlord = (await send(owner, 'post', '/contacts', { name: 'Mehta ji (owner)', phone: '+919829080941' })).body.data;
    const made = await send(owner, 'post', '/records', {
      object: properties.key,
      name: 'A-502, Sunrise Heights',
      contactId: landlord.id,
      customFields: {
        [byLabel(propertyFields, 'BHK').key]: choice(byLabel(propertyFields, 'BHK'), '2 BHK'),
        [byLabel(propertyFields, 'Price (₹)').key]: 6500000,
        [byLabel(propertyFields, 'Status').key]: choice(byLabel(propertyFields, 'Status'), 'Available'),
      },
    });
    expect(made.status).toBe(201);

    const enquiryFields = await leadFields(owner);
    const enquiry = await send(owner, 'post', '/leads', {
      title: '2 BHK in Vijay Nagar',
      contact: { name: 'Rohit Jain', phone: '+919829080942' },
      customFields: {
        [byLabel(enquiryFields, 'Requirement').key]: choice(byLabel(enquiryFields, 'Requirement'), 'Buy'),
        [byLabel(enquiryFields, 'Budget (₹)').key]: 7000000,
        [byLabel(enquiryFields, 'Property').key]: made.body.data.id,
      },
    });
    expect(enquiry.status).toBe(201);
    expect(enquiry.body.data.customFields[byLabel(enquiryFields, 'Property').key]).toBe(made.body.data.id);
  });

  it('is in Hindi for a Hindi user', async () => {
    const owner = await login('estate-hindi@example.com');
    await send(owner, 'patch', '/auth/preferences', { language: 'hi' });
    await change(owner, { crmType: 'real_estate' });
    expect((await stagesOf(owner))[2]).toBe('साइट विज़िट तय');
    expect((await leadFields(owner)).map((field) => field.label)).toEqual(['ज़रूरत', 'प्रॉपर्टी का प्रकार', 'BHK', 'बजट (₹)', 'पसंदीदा इलाका', 'साइट विज़िट की तारीख', 'प्रॉपर्टी']);
    expect((await objects(owner))[0].plural).toBe('प्रॉपर्टी');
  });

  it('with no room for another kind of record, the enquiry\'s property link is left out and the rest still comes', async () => {
    const owner = await login('estate-full@example.com');
    for (let n = 1; n <= 10; n += 1) await send(owner, 'post', '/custom-objects', { singular: `Thing ${n}`, plural: `Things ${n}`, icon: 'box' });
    expect((await change(owner, { crmType: 'real_estate' })).status).toBe(200);
    const labels = (await leadFields(owner)).map((field) => field.label);
    expect(labels).toEqual(['Requirement', 'Property type', 'BHK', 'Budget (₹)', 'Preferred location', 'Site visit date']);
    expect((await organization(owner)).body.data.crmType).toBe('real_estate');
  });
});

describe('Choosing Education / Coaching sets the same CRM up for it', () => {
  it('adds its stages and replies, enquiry fields, Batches linked from every enquiry, and the fee schedule template', async () => {
    const owner = await login('edu-setup@example.com');
    expect((await change(owner, { crmType: 'education' })).status).toBe(200);

    expect(await stagesOf(owner)).toEqual(['New enquiry', 'Counselling done', 'Demo class', 'Fees shared', 'Ready to join']);
    expect((await replies(owner)).map((reply) => reply.shortcut)).toEqual(expect.arrayContaining(['details', 'course', 'demo', 'fees', 'reminder', 'batch', 'documents', 'thanks']));
    expect((await read(owner, '/organization/billing')).terms).toContain('pro-rata');
    expect(await productsOf(owner)).toEqual([]); // what an institute teaches is its own

    expect(await read(owner, '/custom-fields?object=contact')).toEqual([]);
    const [batches] = await objects(owner);
    expect(batches).toMatchObject({ singular: 'Batch', plural: 'Batches', icon: 'user-gear' });
    expect((await read(owner, `/custom-fields?object=${batches.key}`)).map((field) => field.label)).toEqual(['Course', 'Start date', 'Timings', 'Teacher', 'Total seats', 'Seats filled', 'Status']);
    const enquiryFields = await leadFields(owner);
    expect(enquiryFields.map((field) => field.label)).toEqual(['Student name', 'Class or qualification', 'School or college', 'Preferred batch time', 'Enquiry by', 'Demo class date', 'Batch']);
    expect(enquiryFields.filter((field) => field.listColumn).map((field) => field.label)).toEqual(['Class or qualification', 'Preferred batch time']);
    expect(enquiryFields[6]).toMatchObject({ type: 'lookup', lookupTarget: batches.key });

    const [fees] = await read(owner, '/project-templates');
    expect(fees).toMatchObject({ name: 'Admission: fees in 3 instalments', days: 90 });
    expect(fees.milestones.map((milestone) => [milestone.name, milestone.dueAfterDays])).toEqual([['Admission', 0], ['Second instalment', 30], ['Third instalment', 60], ['Course feedback', 90]]);
    expect(fees.tasks).toHaveLength(7);

    expect(await hiddenPages(owner)).toEqual([]);
    expect((await read(owner, '/organization/getting-started')).kit).toBe('education');
    expect((await read(owner, '/organization/business-kits')).kits.map((kit) => kit.id)).toEqual(['trader', 'manufacturer']);
  });

  it('a won admission becomes its fee schedule in one click', async () => {
    const owner = await login('edu-fees@example.com');
    await change(owner, { crmType: 'education' });
    const [fees] = await read(owner, '/project-templates');
    const lead = (await send(owner, 'post', '/leads', { title: 'JEE 2027 — Aarav', contact: { name: 'Sunita Sharma', phone: '+919829080961' } })).body.data;
    await send(owner, 'post', `/leads/${lead.id}/stage`, { stage: 'Won' });
    const started = await send(owner, 'post', `/leads/${lead.id}/project`, { templateId: fees.id, startDate: '2027-04-01' });
    expect(started.status).toBe(201);
    const dueDays = listOf(await read(owner, `/projects/${started.body.data.id}/tasks`)).map((task) => String(task.dueDate).slice(0, 10)).sort();
    expect(dueDays).toEqual(['2027-04-01', '2027-04-02', '2027-04-28', '2027-05-01', '2027-05-28', '2027-05-31', '2027-06-30']);
  });

  it('is in Hindi for a Hindi user', async () => {
    const owner = await login('edu-hindi@example.com');
    await send(owner, 'patch', '/auth/preferences', { language: 'hi' });
    await change(owner, { crmType: 'education' });
    expect((await stagesOf(owner))[2]).toBe('डेमो क्लास');
    expect((await leadFields(owner))[1].label).toBe('क्लास या पढ़ाई');
    expect((await objects(owner))[0].plural).toBe('बैच');
    expect((await read(owner, '/project-templates'))[0].name).toBe('एडमिशन: फ़ीस 3 किस्तों में');
  });
});

describe('Choosing Clinic / Hospital sets the same CRM up for it', () => {
  it('adds its stages and replies, two consultations, enquiry fields, Doctors linked from every enquiry, and the sessions template', async () => {
    const owner = await login('clinic-setup@example.com');
    expect((await change(owner, { crmType: 'clinic' })).status).toBe(200);

    expect(await stagesOf(owner)).toEqual(['New enquiry', 'Appointment booked', 'Consulted', 'Treatment advised', 'Follow-up']);
    expect((await replies(owner)).map((reply) => reply.shortcut)).toEqual(expect.arrayContaining(['details', 'appointment', 'reminder', 'location', 'reports', 'followup', 'estimate', 'review']));
    expect((await read(owner, '/organization/billing')).terms).toContain('cosmetic');
    const consultations = await productsOf(owner);
    expect(consultations.map((one) => one.name).sort()).toEqual(['Consultation', 'Follow-up consultation']);
    expect(consultations.every((one) => one.gstRatePct === 0 && one.pricePaise === 0)).toBe(true);

    const [doctors] = await objects(owner);
    expect(doctors).toMatchObject({ singular: 'Doctor', plural: 'Doctors', icon: 'user-gear' });
    expect((await read(owner, `/custom-fields?object=${doctors.key}`)).map((field) => field.label)).toEqual(['Speciality', 'OPD days and timings', 'Consultation fee (₹)', 'Phone']);
    const enquiryFields = await leadFields(owner);
    expect(enquiryFields.map((field) => field.label)).toEqual(['Patient name', 'Department', 'Doctor', 'Appointment date', 'Visit type']);
    expect(enquiryFields.filter((field) => field.listColumn).map((field) => field.label)).toEqual(['Department', 'Appointment date', 'Visit type']);
    expect(enquiryFields[2]).toMatchObject({ type: 'lookup', lookupTarget: doctors.key });
    // No medical record: nothing like a diagnosis or a history is added.
    expect(enquiryFields.some((field) => /diagnos|history|medicine/i.test(field.label))).toBe(false);

    const [sessions] = await read(owner, '/project-templates');
    expect(sessions).toMatchObject({ name: 'Treatment: 6 weekly sessions', days: 36 });
    expect(sessions.milestones).toHaveLength(7);
    expect(sessions.tasks).toHaveLength(12);

    expect(await hiddenPages(owner)).toEqual([]);
    expect((await read(owner, '/organization/getting-started')).kit).toBe('clinic');
  });

  it('a won case becomes six weekly sessions with reminders in one click', async () => {
    const owner = await login('clinic-sessions@example.com');
    await change(owner, { crmType: 'clinic' });
    const [sessions] = await read(owner, '/project-templates');
    const lead = (await send(owner, 'post', '/leads', { title: 'Knee physiotherapy', contact: { name: 'Kamla Devi', phone: '+919829080971' } })).body.data;
    await send(owner, 'post', `/leads/${lead.id}/stage`, { stage: 'Won' });
    const started = await send(owner, 'post', `/leads/${lead.id}/project`, { templateId: sessions.id, startDate: '2027-01-04' });
    expect(started.status).toBe(201);
    const dueDays = listOf(await read(owner, `/projects/${started.body.data.id}/tasks`)).map((task) => String(task.dueDate).slice(0, 10)).sort();
    expect(dueDays).toEqual(['2027-01-04', '2027-01-10', '2027-01-11', '2027-01-17', '2027-01-18', '2027-01-24', '2027-01-25', '2027-01-31', '2027-02-01', '2027-02-07', '2027-02-08', '2027-02-09']);
  });

  it('is in Hindi for a Hindi user', async () => {
    const owner = await login('clinic-hindi@example.com');
    await send(owner, 'patch', '/auth/preferences', { language: 'hi' });
    await change(owner, { crmType: 'clinic' });
    expect((await stagesOf(owner))[1]).toBe('अपॉइंटमेंट बुक');
    expect((await leadFields(owner))[0].label).toBe('मरीज़ का नाम');
    expect((await objects(owner))[0].plural).toBe('डॉक्टर');
    expect((await productsOf(owner)).map((one) => one.name)).toContain('परामर्श');
  });
});

describe('Choosing Travel Agency sets the same CRM up for it', () => {
  it('adds its stages and replies, trip fields, Suppliers, and hides Projects', async () => {
    const owner = await login('travel-setup@example.com');
    expect((await change(owner, { crmType: 'travel' })).status).toBe(200);

    expect(await stagesOf(owner)).toEqual(['New enquiry', 'Requirement understood', 'Itinerary sent', 'Negotiation', 'Advance awaited']);
    expect((await replies(owner)).map((reply) => reply.shortcut)).toEqual(expect.arrayContaining(['details', 'itinerary', 'documents', 'advance', 'balance', 'visa', 'departure', 'feedback']));
    const billing = await read(owner, '/organization/billing');
    expect(billing.terms).toContain('Cancellation charges');
    expect(billing.validityDays).toBe(3);
    expect(await productsOf(owner)).toEqual([]); // what an agency sells is its own

    const [suppliers] = await objects(owner);
    expect(suppliers).toMatchObject({ singular: 'Supplier', plural: 'Suppliers', icon: 'building' });
    const supplierFields = await read(owner, `/custom-fields?object=${suppliers.key}`);
    expect(supplierFields.map((field) => [field.label, field.type])).toEqual([['Supplier type', 'dropdown'], ['City', 'text'], ['Phone', 'text'], ['Rates and notes', 'textarea']]);
    const enquiryFields = await leadFields(owner);
    expect(enquiryFields.map((field) => field.label)).toEqual(['Destination', 'Travel date', 'Nights', 'Adults', 'Children', 'Budget (₹)', 'Hotel category', 'Trip type', 'Departure city']);
    expect(enquiryFields.filter((field) => field.listColumn).map((field) => field.label)).toEqual(['Destination', 'Travel date', 'Budget (₹)']);

    expect(await read(owner, '/project-templates')).toEqual([]);
    expect(await hiddenPages(owner)).toEqual(['projects']);
    expect((await read(owner, '/organization/getting-started')).kit).toBe('travel');
  });

  it('is in Hindi for a Hindi user', async () => {
    const owner = await login('travel-hindi@example.com');
    await send(owner, 'patch', '/auth/preferences', { language: 'hi' });
    await change(owner, { crmType: 'travel' });
    expect((await stagesOf(owner))[2]).toBe('यात्रा प्लान भेजा');
    expect((await leadFields(owner))[0].label).toBe('कहाँ जाना है');
    expect((await objects(owner))[0].plural).toBe('सप्लायर');
  });
});

describe('Choosing Insurance / Loan Agent sets the same CRM up for it', () => {
  it('adds its stages and replies, the usual products, client and enquiry fields, Policies and the renewal template', async () => {
    const owner = await login('insurance-setup@example.com');
    expect((await change(owner, { crmType: 'insurance' })).status).toBe(200);

    expect(await stagesOf(owner)).toEqual(['New enquiry', 'Need understood', 'Options shared', 'Documents collected', 'Application submitted']);
    expect((await replies(owner)).map((reply) => reply.shortcut)).toEqual(expect.arrayContaining(['details', 'options', 'documents', 'submitted', 'approved', 'renewal', 'referral']));
    expect((await read(owner, '/organization/billing')).terms).toContain('paid to the insurer or the bank directly');
    const products = await productsOf(owner);
    expect(products.map((one) => one.name)).toEqual(expect.arrayContaining(['Term insurance', 'Health insurance', 'Home loan', 'Loan against property']));
    expect(products).toHaveLength(9);
    expect(products.every((one) => one.pricePaise === 0 && one.gstRatePct === 0)).toBe(true);

    expect((await read(owner, '/custom-fields?object=contact')).map((field) => field.label)).toEqual(['Date of birth', 'Occupation']);
    expect((await leadFields(owner)).map((field) => field.label)).toEqual(['Cover or loan amount (₹)', 'Monthly income (₹)', 'Insurer or bank', 'Application number']);
    const [policies] = await objects(owner);
    expect(policies).toMatchObject({ singular: 'Policy', plural: 'Policies', icon: 'shield-halved' });
    const policyFields = await read(owner, `/custom-fields?object=${policies.key}`);
    expect(policyFields.map((field) => field.label)).toEqual(['Policy type', 'Insurer', 'Policy number', 'Premium (₹)', 'Premium frequency', 'Renewal date', 'Status']);
    expect(policyFields.filter((field) => field.listColumn).map((field) => field.label)).toEqual(['Premium (₹)', 'Renewal date', 'Status']);

    const [renewal] = await read(owner, '/project-templates');
    expect(renewal).toMatchObject({ name: 'Policy: a year to the renewal', days: 365 });
    expect(renewal.tasks.map((task) => task.dueAfterDays)).toEqual([0, 15, 335, 358, 365]);

    expect(await hiddenPages(owner)).toEqual([]);
    expect((await read(owner, '/organization/getting-started')).kit).toBe('insurance');
  });

  it('is in Hindi for a Hindi user', async () => {
    const owner = await login('insurance-hindi@example.com');
    await send(owner, 'patch', '/auth/preferences', { language: 'hi' });
    await change(owner, { crmType: 'insurance' });
    expect((await stagesOf(owner))[4]).toBe('आवेदन जमा');
    expect((await productsOf(owner)).map((one) => one.name)).toContain('होम लोन');
    expect((await objects(owner))[0].plural).toBe('पॉलिसी');
    expect((await read(owner, '/project-templates'))[0].name).toBe('पॉलिसी: रिन्यूअल तक का साल');
  });
});

describe('Choosing Salon / Spa sets the same CRM up for it', () => {
  it('adds its stages and replies, the service menu at 5% GST, client and enquiry fields, and the package template', async () => {
    const owner = await login('salon-setup@example.com');
    expect((await change(owner, { crmType: 'salon' })).status).toBe(200);

    expect(await stagesOf(owner)).toEqual(['New enquiry', 'Services and rates shared', 'Package quoted', 'Booking fixed']);
    expect((await replies(owner)).map((reply) => reply.shortcut)).toEqual(expect.arrayContaining(['details', 'menu', 'booking', 'reminder', 'bridal', 'rebook', 'birthday', 'review']));
    expect((await read(owner, '/organization/billing')).terms).toContain('allergy');
    const services = await productsOf(owner);
    expect(services).toHaveLength(11);
    expect(services.map((one) => one.name)).toEqual(expect.arrayContaining(['Haircut', 'Facial', 'Bridal makeup']));
    expect(services.every((one) => one.gstRatePct === 5 && one.hsnSac === '9997' && one.pricePaise === 0)).toBe(true);

    const clientFields = await read(owner, '/custom-fields?object=contact');
    expect(clientFields.map((field) => [field.label, field.type])).toEqual([['Birthday', 'date'], ['Preferred stylist', 'text'], ['Allergies or skin notes', 'textarea']]);
    expect((await leadFields(owner)).map((field) => field.label)).toEqual(['Appointment date', 'Stylist', 'Occasion']);
    expect(await objects(owner)).toEqual([]);

    const [sittings] = await read(owner, '/project-templates');
    expect(sittings).toMatchObject({ name: 'Package: 6 monthly sittings', days: 151 });
    expect(sittings.milestones).toHaveLength(7);
    expect(sittings.tasks).toHaveLength(12);

    expect(await hiddenPages(owner)).toEqual([]);
    expect((await read(owner, '/organization/getting-started')).kit).toBe('salon');
  });

  it('is in Hindi for a Hindi user', async () => {
    const owner = await login('salon-hindi@example.com');
    await send(owner, 'patch', '/auth/preferences', { language: 'hi' });
    await change(owner, { crmType: 'salon' });
    expect((await stagesOf(owner))[3]).toBe('बुकिंग पक्की');
    expect((await productsOf(owner)).map((one) => one.name)).toContain('हेयरकट');
    expect((await read(owner, '/custom-fields?object=contact'))[0].label).toBe('जन्मदिन');
    expect((await read(owner, '/project-templates'))[0].name).toBe('पैकेज: हर महीने 6 सेशन');
  });
});

describe('Choosing Gym / Fitness sets the same CRM up for it', () => {
  it('adds its stages and replies, the packages at 5% GST, member and enquiry fields, Memberships and the 3-month template', async () => {
    const owner = await login('gym-setup@example.com');
    expect((await change(owner, { crmType: 'gym' })).status).toBe(200);

    expect(await stagesOf(owner)).toEqual(['New enquiry', 'Trial booked', 'Trial done', 'Package shared', 'Ready to join']);
    expect((await replies(owner)).map((reply) => reply.shortcut)).toEqual(expect.arrayContaining(['details', 'trial', 'packages', 'welcome', 'renewal', 'missed', 'referral', 'review']));
    expect((await read(owner, '/organization/billing')).terms).toContain('medical condition');
    const packages = await productsOf(owner);
    expect(packages).toHaveLength(6);
    expect(packages.every((one) => one.gstRatePct === 5 && one.hsnSac === '9997' && one.pricePaise === 0)).toBe(true);

    expect((await read(owner, '/custom-fields?object=contact')).map((field) => field.label)).toEqual(['Birthday', 'Fitness goal', 'Injuries or health notes']);
    expect((await leadFields(owner)).map((field) => field.label)).toEqual(['Trial date', 'Preferred time']);
    const [memberships] = await objects(owner);
    expect(memberships).toMatchObject({ singular: 'Membership', plural: 'Memberships', icon: 'tag' });
    expect((await read(owner, `/custom-fields?object=${memberships.key}`)).map((field) => field.label)).toEqual(['Package', 'Start date', 'End date', 'Amount paid (₹)', 'Personal trainer', 'Status']);

    const [threeMonths] = await read(owner, '/project-templates');
    expect(threeMonths).toMatchObject({ name: 'Membership: 3 months', days: 90 });
    expect(threeMonths.tasks.map((task) => task.dueAfterDays)).toEqual([0, 7, 30, 60, 80, 87, 90]);

    expect(await hiddenPages(owner)).toEqual([]);
    expect((await read(owner, '/organization/getting-started')).kit).toBe('gym');
  });

  it('is in Hindi for a Hindi user', async () => {
    const owner = await login('gym-hindi@example.com');
    await send(owner, 'patch', '/auth/preferences', { language: 'hi' });
    await change(owner, { crmType: 'gym' });
    expect((await stagesOf(owner))[1]).toBe('ट्रायल बुक');
    expect((await productsOf(owner)).map((one) => one.name)).toContain('सालाना मेंबरशिप');
    expect((await objects(owner))[0].plural).toBe('मेंबरशिप');
  });
});

describe('Choosing Interior / Construction sets the same CRM up for it', () => {
  it('adds its stages and replies, client and enquiry fields, Vendors and the 45-day project template', async () => {
    const owner = await login('interior-setup@example.com');
    expect((await change(owner, { crmType: 'interior' })).status).toBe(200);

    expect(await stagesOf(owner)).toEqual(['New enquiry', 'Site visit and measurement', 'Design shared', 'Quotation sent', 'Negotiation']);
    expect((await replies(owner)).map((reply) => reply.shortcut)).toEqual(expect.arrayContaining(['details', 'visit', 'design', 'quote', 'payment', 'update', 'handover', 'review']));
    expect((await read(owner, '/organization/billing')).terms).toContain('quantity actually measured');
    expect(await productsOf(owner)).toEqual([]); // a rate list is each firm's own

    expect((await read(owner, '/custom-fields?object=contact')).map((field) => field.label)).toEqual(['Client type']);
    const enquiryFields = await leadFields(owner);
    expect(enquiryFields.map((field) => field.label)).toEqual(['Work needed', 'Property type', 'Rooms or BHK', 'Area (sq ft)', 'Budget (₹)', 'Site address', 'Site visit date', 'Start by', 'Referred by']);
    expect(enquiryFields.filter((field) => field.listColumn).map((field) => field.label)).toEqual(['Work needed', 'Budget (₹)', 'Site visit date']);
    const [vendors] = await objects(owner);
    expect(vendors).toMatchObject({ singular: 'Vendor', plural: 'Vendors', icon: 'wrench' });

    const [project] = await read(owner, '/project-templates');
    expect(project).toMatchObject({ name: 'Interior project: 45 days', days: 45 });
    expect(project.milestones.map((milestone) => milestone.name)).toEqual(['Design sign-off', 'Material ordered', 'Carpentry and civil work', 'Painting and finishing', 'Handover']);
    expect(project.tasks).toHaveLength(10);

    expect(await hiddenPages(owner)).toEqual([]);
    expect((await read(owner, '/organization/getting-started')).kit).toBe('interior');
  });

  it('a won job becomes its 45-day project in one click', async () => {
    const owner = await login('interior-project@example.com');
    await change(owner, { crmType: 'interior' });
    const [project] = await read(owner, '/project-templates');
    const lead = (await send(owner, 'post', '/leads', { title: '3 BHK full interior', contact: { name: 'Anjali Desai', phone: '+919829081011' } })).body.data;
    await send(owner, 'post', `/leads/${lead.id}/stage`, { stage: 'Won' });
    const started = await send(owner, 'post', `/leads/${lead.id}/project`, { templateId: project.id });
    expect(started.status).toBe(201);
    expect(started.body.data.milestones).toHaveLength(5);
    expect(started.body.data.tasks).toMatchObject({ total: 10, done: 0 });
  });

  it('is in Hindi for a Hindi user', async () => {
    const owner = await login('interior-hindi@example.com');
    await send(owner, 'patch', '/auth/preferences', { language: 'hi' });
    await change(owner, { crmType: 'interior' });
    expect((await stagesOf(owner))[1]).toBe('साइट विज़िट और नाप');
    expect((await leadFields(owner))[0].label).toBe('कौन-सा काम');
    expect((await read(owner, '/project-templates'))[0].name).toBe('इंटीरियर प्रोजेक्ट: 45 दिन');
  });
});

describe('Choosing Solar Installer sets the same CRM up for it', () => {
  it('adds its stages and replies, enquiry fields, Installations and the 30-day rooftop template', async () => {
    const owner = await login('solar-setup@example.com');
    expect((await change(owner, { crmType: 'solar' })).status).toBe(200);

    expect(await stagesOf(owner)).toEqual(['New enquiry', 'Site survey done', 'Quotation sent', 'Documents and subsidy', 'Advance awaited']);
    expect((await replies(owner)).map((reply) => reply.shortcut)).toEqual(expect.arrayContaining(['details', 'survey', 'quote', 'subsidy', 'install', 'netmeter', 'cleaning', 'review']));
    expect((await read(owner, '/organization/billing')).terms).toContain('Net metering');
    expect(await productsOf(owner)).toEqual([]); // a system's GST is split goods/services (70:30)

    const enquiryFields = await leadFields(owner);
    expect(enquiryFields.map((field) => field.label)).toEqual(['Category', 'Monthly bill (₹)', 'Sanctioned load (kW)', 'System size (kW)', 'System type', 'Roof type', 'Shadow-free roof area (sq ft)', 'Electricity board', 'Consumer number', 'Subsidy']);
    expect(enquiryFields.filter((field) => field.listColumn).map((field) => field.label)).toEqual(['Category', 'Monthly bill (₹)', 'System size (kW)']);
    const [installations] = await objects(owner);
    expect(installations).toMatchObject({ singular: 'Installation', plural: 'Installations', icon: 'bolt' });
    expect((await read(owner, `/custom-fields?object=${installations.key}`)).map((field) => field.label)).toEqual(['System size (kW)', 'Commissioned on', 'Net meter installed on', 'Panel warranty till', 'AMC till', 'Status']);

    const [rooftop] = await read(owner, '/project-templates');
    expect(rooftop).toMatchObject({ name: 'Rooftop solar: 30 days', days: 30 });
    expect(rooftop.milestones).toHaveLength(5);
    expect(rooftop.tasks).toHaveLength(10);

    expect(await hiddenPages(owner)).toEqual([]);
    expect((await read(owner, '/organization/getting-started')).kit).toBe('solar');
  });

  it('is in Hindi for a Hindi user', async () => {
    const owner = await login('solar-hindi@example.com');
    await send(owner, 'patch', '/auth/preferences', { language: 'hi' });
    await change(owner, { crmType: 'solar' });
    expect((await stagesOf(owner))[1]).toBe('साइट सर्वे हो गया');
    expect((await leadFields(owner))[1].label).toBe('महीने का बिजली बिल (₹)');
    expect((await read(owner, '/project-templates'))[0].name).toBe('रूफ़टॉप सोलर: 30 दिन');
  });
});
