jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Contact = require('../models/Contact');
const LeadActivity = require('../models/LeadActivity');
const Message = require('../models/Message');
const queue = require('../jobs/queue');
const engine = require('../services/automation/engine');
const sequenceEngine = require('../services/automation/sequences');
const leadRouting = require('../services/leadRoutingService');
const { parseCsv } = require('../utils/csv');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const settle = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};

beforeAll(() => {
  leadRouting.attach(queue);
  engine.register(queue);
  sequenceEngine.register(queue);
});
afterAll(() => queue.stop());

describe('CSV reading', () => {
  it('reads quotes, commas and line breaks in fields, semicolon files and a byte-order mark', () => {
    expect(parseCsv('﻿Name,Phone\r\n"Ravi, Jaipur",98290 11111\n"Meena ""Spices""","line\nbreak"\n\n')).toEqual([
      ['Name', 'Phone'], ['Ravi, Jaipur', '98290 11111'], ['Meena "Spices"', 'line\nbreak'],
    ]);
    expect(parseCsv('Name;Mobile;City\nKiran;9829011111;Ajmer')).toEqual([['Name', 'Mobile', 'City'], ['Kiran', '9829011111', 'Ajmer']]);
    expect(parseCsv('')).toEqual([]);
  });
});

describe('Marketing consent', () => {
  let owner;
  const auth = () => bearer(owner.token);
  beforeAll(async () => {
    owner = await login('consent-owner@example.com', { name: 'Asha' });
    await api().patch('/api/v1/organization').set(auth()).send({ name: 'Yellow Traders' });
    await api().post('/api/v1/whatsapp/accounts').set(auth()).send({ provider: 'mock' });
  });

  it('is set on the customer form and filtered on', async () => {
    const yes = (await api().post('/api/v1/contacts').set(auth()).send({ name: 'Agreed', phone: '98290 60001', marketingConsent: 'opted_in' })).body.data;
    expect(yes.consent).toMatchObject({ marketing: 'opted_in', method: 'manual' });
    expect(yes.consent.changedAt).toBeTruthy();
    const plain = (await api().post('/api/v1/contacts').set(auth()).send({ name: 'Not asked', phone: '98290 60002' })).body.data;
    expect(plain.consent.marketing).toBe('unknown');
    const changed = (await api().patch(`/api/v1/contacts/${plain.id}`).set(auth()).send({ marketingConsent: 'opted_out' })).body.data;
    expect(changed.consent).toMatchObject({ marketing: 'opted_out', method: 'manual' });
    const optedIn = (await api().get('/api/v1/contacts?consent=opted_in').set(auth())).body.data.map((c) => c.name);
    expect(optedIn).toEqual(['Agreed']);
    expect((await api().get('/api/v1/contacts?consent=unknown').set(auth())).body.data.map((c) => c.name)).not.toContain('Not asked');
  });

  it('follows STOP and START on WhatsApp, with a confirmation and no bot answer', async () => {
    await api().put('/api/v1/bot/settings').set(auth()).send({ enabled: true });
    await api().put('/api/v1/organization/business-hours').set(auth()).send({ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' });
    const first = (await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(auth()).send({ from: '98290 60011', name: 'Ravi', text: 'Hi' })).body.data;
    await settle();
    await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(auth()).send({ from: '98290 60011', name: 'Ravi', text: ' STOP! ' });
    await settle();
    let contact = await Contact.findById(first.contactId);
    expect(contact.consent).toMatchObject({ marketing: 'opted_out', method: 'whatsapp_reply' });
    const replies = await Message.find({ conversationId: first.conversationId, direction: 'out' }).sort({ createdAt: 1 });
    expect(replies.map((m) => m.automation.kind)).toEqual(['bot', 'consent']); // the greeting, then the confirmation
    expect(replies[1].text).toBe('You will not get offers from Yellow Traders on WhatsApp any more. Reply START to get them again.');
    expect((await LeadActivity.find({ contactId: first.contactId, type: 'Consent' })).map((a) => a.text)).toEqual(['Opted out of WhatsApp offers (replied STOP).']);
    // "stop sending the old price list" is a normal message, not an opt-out.
    await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(auth()).send({ from: '98290 60011', name: 'Ravi', text: 'Start' });
    await settle();
    contact = await Contact.findById(first.contactId);
    expect(contact.consent.marketing).toBe('opted_in');
    await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(auth()).send({ from: '98290 60011', name: 'Ravi', text: 'please stop sending the old price list' });
    await settle();
    expect((await Contact.findById(first.contactId)).consent.marketing).toBe('opted_in');
    await api().put('/api/v1/bot/settings').set(auth()).send({ enabled: false });
  });
});

describe('Segments', () => {
  let owner;
  let agent;
  let cumin;
  const auth = () => bearer(owner.token);
  const contact = (body) => api().post('/api/v1/contacts').set(auth()).send(body);
  const preview = async (filters) => (await api().post('/api/v1/segments/preview').set(auth()).send({ filters })).body.data;

  beforeAll(async () => {
    owner = await login('segment-owner@example.com', { name: 'Asha' });
    agent = await inviteAndJoin(owner.token, 'segment-agent@example.com', { role: 'agent', modules: ['marketing', 'customers'] });
    cumin = (await api().post('/api/v1/products').set(auth()).send({ name: 'Cumin 25kg', category: 'Spices', pricePaise: 100000 })).body.data;
    await contact({ name: 'Ravi Traders', phone: '98290 70001', state: 'Rajasthan', city: 'Jaipur', tags: ['Tier A'], lifecycle: 'customer', productIds: [cumin.id] });
    await contact({ name: 'Kiran Stores', phone: '98290 70002', state: 'rajasthan', city: 'Ajmer', tags: ['tier a', 'Wholesale'], lifecycle: 'customer', marketingConsent: 'opted_out' });
    await contact({ name: 'Surat Mart', phone: '98290 70003', state: 'Gujarat', city: 'Surat', tags: ['Tier A'] });
    await contact({ name: 'Email Only', email: 'only@example.com', state: 'Rajasthan', tags: ['Tier A'] });
    const lead = (await api().post('/api/v1/leads').set(auth()).send({ contact: { name: 'Meena Spices', phone: '98290 70004' }, productId: cumin.id, title: 'Cumin' })).body.data;
    await api().patch(`/api/v1/leads/${lead.id}`).set(auth()).send({ stage: 'Negotiation' });
  });

  it('matches tags, places, products and stages (capitals ignored) and never the opted-out', async () => {
    const tierA = await preview({ tagsAll: ['TIER A'], states: ['Rajasthan'] });
    expect(tierA).toMatchObject({ total: 2, withWhatsApp: 1, optedOut: 1 });
    expect(tierA.sample.map((c) => c.name).sort()).toEqual(['Email Only', 'Ravi Traders']);
    expect((await preview({ productCategories: ['spices'] })).sample.map((c) => c.name).sort()).toEqual(['Meena Spices', 'Ravi Traders']);
    expect((await preview({ leadStages: ['Negotiation'] })).sample.map((c) => c.name)).toEqual(['Meena Spices']);
    expect((await preview({ tagsAny: ['wholesale'], consent: 'not_opted_out' })).total).toBe(0);
    expect((await preview({ cities: ['jaipur', 'surat'], tagsNone: ['tier a'] })).total).toBe(0);
    expect((await preview({ lifecycles: ['customer'] })).sample.map((c) => c.name)).toEqual(['Ravi Traders']);
  });

  it('saves segments for owners and admins only, within the organization', async () => {
    const saved = await api().post('/api/v1/segments').set(auth()).send({ name: 'Tier A – Rajasthan', filters: { tagsAll: ['Tier A'], states: ['Rajasthan'] } });
    expect(saved.status).toBe(201);
    expect((await api().get('/api/v1/segments').set(auth())).body.data).toMatchObject([{ name: 'Tier A – Rajasthan', count: 2 }]);
    expect((await api().get(`/api/v1/segments/${saved.body.data.id}/preview`).set(auth())).body.data.total).toBe(2);
    const options = (await api().get('/api/v1/segments/options').set(auth())).body.data;
    expect(options.tags).toEqual(expect.arrayContaining(['Tier A', 'Wholesale']));
    expect(options).toMatchObject({ productCategories: ['Spices'], cities: ['Ajmer', 'Jaipur', 'Surat'] });

    expect((await api().get('/api/v1/segments').set(bearer(agent.token))).status).toBe(403);
    const stranger = await login('segment-stranger@example.com');
    expect((await api().get(`/api/v1/segments/${saved.body.data.id}`).set(bearer(stranger.token))).status).toBe(404);
    expect((await api().post('/api/v1/segments/preview').set(bearer(stranger.token)).send({ filters: { tagsAll: ['Tier A'] } })).body.data.total).toBe(0);
    const foreign = await api().post('/api/v1/segments').set(bearer(stranger.token)).send({ name: 'x', filters: { productIds: [cumin.id] } });
    expect(foreign.body.errors[0].code).toBe('INVALID_PRODUCT');
  });
});

describe('Importing customers from CSV', () => {
  let owner;
  let agent;
  const auth = () => bearer(owner.token);
  const csv = (text) => Buffer.from(text, 'utf8');
  const upload = (path, text, fields = {}, token = owner.token) => {
    const req = api().post(`/api/v1/contacts${path}`).set(bearer(token)).attach('file', csv(text), 'customers.csv');
    for (const [key, value] of Object.entries(fields)) req.field(key, typeof value === 'string' ? value : JSON.stringify(value));
    return req;
  };
  const FILE = [
    'Party Name,Mobile No,E-mail,City,State,GST No,Group,Remarks',
    'Ravi Traders,98290 80001,ravi@example.com,Jaipur,Rajasthan,08AAACR1234C1Z5,"Tier A, Wholesale",Old buyer',
    'Ravi Traders (2nd branch),+91 98290-80001,,,,,Tier B,',
    'Bad Number,12345,,,,,,',
    'No Contact,,,,,,,',
    'Email Person,,mail@example.com,Ajmer,Rajasthan,,,',
    'Existing One,98290 80009,,Kota,Rajasthan,,Tier A,',
    'Said No,98290 80010,,,,,,',
  ].join('\n');

  beforeAll(async () => {
    owner = await login('import-owner@example.com', { name: 'Asha' });
    agent = await inviteAndJoin(owner.token, 'import-agent@example.com', { role: 'agent', modules: ['customers'] });
    await api().post('/api/v1/contacts').set(auth()).send({ name: 'Existing One', phone: '98290 80009', city: '', tags: ['VIP'] });
    await api().post('/api/v1/contacts').set(auth()).send({ name: 'Said No', phone: '98290 80010', marketingConsent: 'opted_out' });
  });

  it('suggests the columns from their names', async () => {
    const res = await upload('/import/preview', FILE);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      headers: ['Party Name', 'Mobile No', 'E-mail', 'City', 'State', 'GST No', 'Group', 'Remarks'],
      mapping: ['name', 'phone', 'email', 'city', 'state', 'gstin', 'tags', 'notes'],
      totalRows: 7,
    });
    expect(res.body.data.rows[0][0]).toBe('Ravi Traders');
    const excel = await api().post('/api/v1/contacts/import/preview').set(auth()).attach('file', Buffer.from('PK...'), 'customers.xlsx');
    expect(excel.body.code).toBe('UNSUPPORTED_FILE');
  });

  it('checks first, then adds new people, merges repeats and fills in people already here', async () => {
    const mapping = ['name', 'phone', 'email', 'city', 'state', 'gstin', 'tags', 'notes'];
    const dry = await upload('/import', FILE, { mapping, tags: 'Diwali 2026', consent: 'opted_in', dryRun: 'true' });
    expect(dry.body.data).toMatchObject({ totalRows: 7, created: 2, updated: 2, mergedInFile: 1, rejected: 2, dryRun: true });
    expect(await Contact.countDocuments({ phoneE164: '+919829080001' })).toBe(0);

    const res = await upload('/import', FILE, { mapping, tags: 'Diwali 2026', consent: 'opted_in' });
    expect(res.body.data).toMatchObject({ created: 2, updated: 2, unchanged: 0, mergedInFile: 1, rejected: 2 });
    expect(res.body.data.rejectedRows).toEqual([{ row: 4, text: '"12345" is not a phone number' }, { row: 5, text: 'no phone number or email' }]);
    const ravi = await Contact.findOne({ phoneE164: '+919829080001' });
    expect(ravi).toMatchObject({ name: 'Ravi Traders', email: 'ravi@example.com', city: 'Jaipur', gstin: '08AAACR1234C1Z5', stateCode: '08', source: 'Import', lifecycle: 'customer', consent: { marketing: 'opted_in', method: 'import' } });
    expect([...ravi.tags].sort()).toEqual(['Diwali 2026', 'Tier A', 'Tier B', 'Wholesale']);
    expect(await Contact.exists({ email: 'mail@example.com', city: 'Ajmer' })).toBeTruthy();
    const existing = await Contact.findOne({ phoneE164: '+919829080009' });
    expect(existing).toMatchObject({ name: 'Existing One', city: 'Kota', consent: { marketing: 'opted_in' } });
    expect(existing.tags).toEqual(['VIP', 'Tier A', 'Diwali 2026']);
    // Someone who said no stays opted out.
    expect((await Contact.findOne({ phoneE164: '+919829080010' })).consent.marketing).toBe('opted_out');

    // The same file again: nothing new.
    const again = await upload('/import', FILE, { mapping, tags: 'Diwali 2026', consent: 'opted_in' });
    expect(again.body.data).toMatchObject({ created: 0, updated: 0, unchanged: 4 });
  });

  it('needs the phone (or email) column, and lets agents update only their own customers', async () => {
    const noPhone = await upload('/import', 'Name,City\nX,Y', { mapping: ['name', 'city'] });
    expect(noPhone.body.errors[0].code).toBe('PHONE_REQUIRED');
    const res = await upload('/import', 'Name,Mobile,City\nRavi Traders,98290 80001,Mumbai\nAgent Buyer,98290 80021,Pune', { mapping: ['name', 'phone', 'city'], tags: 'Agent list' }, agent.token);
    expect(res.body.data).toMatchObject({ created: 1, updated: 0, unchanged: 1 });
    const agentMember = (await api().get('/api/v1/members').set(auth())).body.data.find((m) => m.email === 'import-agent@example.com');
    expect(String((await Contact.findOne({ phoneE164: '+919829080021' })).ownerId)).toBe(agentMember.id);
    expect((await Contact.findOne({ phoneE164: '+919829080001' })).tags).not.toContain('Agent list');
    const stranger = await login('import-stranger@example.com');
    const theirs = await upload('/import', 'Name,Mobile\nRavi Traders,98290 80001', { mapping: ['name', 'phone'] }, stranger.token);
    expect(theirs.body.data.created).toBe(1); // their own organization: a new contact there
    expect(await Contact.countDocuments({ phoneE164: '+919829080001' })).toBe(2);
  });
});
