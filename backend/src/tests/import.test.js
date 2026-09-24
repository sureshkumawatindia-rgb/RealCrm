jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Product = require('../models/Product');
const Quotation = require('../models/Quotation');
const LeadActivity = require('../models/LeadActivity');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Shapes copied from the old browser-only CRM (localStorage values are JSON strings).
const browserData = () => ({
  crm_products: JSON.stringify([
    { id: 'p_cumin', name: 'Cumin 1kg', category: 'Spices', price: '250', gst: 5, quantity: '40', createdAt: '2026-01-10T10:00:00.000Z' },
    { id: 'p_empty', name: '' },
  ]),
  crm_customers: JSON.stringify([
    { id: 'c_ravi', name: 'Ravi Traders', email: 'ravi@traders.example', phone: '98290 12345', company: 'Ravi Traders', product: 'p_cumin', status: 'Active' },
  ]),
  crm_leads: JSON.stringify([
    { id: 'l_ravi', name: 'Ravi (lead)', phone: '+91 98290-12345', status: 'In Progress', product: 'p_cumin', quantity: '10', value: '2500', followUp: '2026-10-01', createdAt: '2026-02-01T09:00:00.000Z' },
    { id: 'l_won', name: 'Meena Stores', email: 'meena@stores.example', status: 'Won', value: '1000' },
    { id: 'l_odd', name: 'Odd Status', status: 'Maybe' },
  ]),
  crm_deals: JSON.stringify([
    { id: 'd_big', name: 'Diwali order', account: 'Meena Stores', contact: 'Meena Stores', value: 50000, stage: 'Proposal', owner: 'Someone Unknown', closeDate: '2026-10-20',
      notes: [{ text: 'Sent price list', at: '2026-09-01T10:00:00.000Z', author: 'Anil' }] },
    { id: 'd_lost', name: 'Lost deal', account: 'Far Away Co', stage: 'Lost', value: 100 },
  ]),
  crm_lead_activities: JSON.stringify([
    { id: 'act_1', leadId: 'l_ravi', type: 'Lead created', text: 'Lead created', createdAt: '2026-02-01T09:00:00.000Z' },
    { id: 'act_orphan', leadId: 'l_missing', type: 'Note', text: 'x' },
  ]),
  crm_quotations: JSON.stringify([
    { id: 'q_1', leadId: 'l_ravi', quotationNumber: 'QT-2026-0001', status: 'Draft', items: [{ productId: 'p_cumin', quantity: 10, unitPrice: 250, discount: 0, tax: 5 }], grandTotal: 999999 },
  ]),
  crm_tasks: JSON.stringify([{ id: 't_1', title: 'Call back' }]),
  crm_campaigns: 'not json',
});

describe('POST /imports/localstorage', () => {
  let owner;
  beforeAll(async () => { owner = await login('import-owner@example.com'); });

  const run = (dryRun, data = browserData(), token = owner.token) => api()
    .post('/api/v1/imports/localstorage').set(bearer(token)).send({ data, dryRun });

  it('previews without writing anything', async () => {
    const res = await run(true);
    expect(res.status).toBe(200);
    const { sections, later, problems } = res.body.data.report;
    expect(sections.products).toMatchObject({ found: 2, created: 1, rejected: 1 });
    expect(sections.leads).toMatchObject({ found: 3, created: 3 });
    expect(later).toEqual({ crm_tasks: 1 });
    expect(problems).toEqual([{ key: 'crm_campaigns', reason: 'Not valid JSON' }]);
    expect(await Product.countDocuments()).toBe(0);
    expect(await Lead.countDocuments()).toBe(0);
  });

  it('imports, merges by phone, maps stages and recomputes quotation totals', async () => {
    const res = await run(false);
    expect(res.status).toBe(201);
    const { sections, unresolved } = res.body.data.report;
    expect(sections.customers).toMatchObject({ created: 1 });
    expect(sections.leads).toMatchObject({ created: 3 });
    expect(sections.deals).toMatchObject({ created: 2 });
    expect(sections.leadActivities).toMatchObject({ created: 1, rejected: 1 });
    expect(sections.quotations).toMatchObject({ created: 1 });
    expect(unresolved.join(' ')).toMatch(/Someone Unknown/);
    expect(unresolved.join(' ')).toMatch(/Odd Status/);

    const product = await Product.findOne({ legacyIds: 'p_cumin' });
    expect(product).toMatchObject({ pricePaise: 25000, gstRatePct: 5, stockQty: 40 });
    expect(product.createdAt.toISOString()).toBe('2026-01-10T10:00:00.000Z');

    // The lead with the same phone as the customer shares the customer's contact.
    const ravi = await Contact.findOne({ phoneE164: '+919829012345' });
    const raviLead = await Lead.findOne({ legacyIds: 'l_ravi' });
    expect(String(raviLead.contactId)).toBe(String(ravi._id));
    expect(raviLead).toMatchObject({ stage: 'Contacted', probability: 25, quantity: 10, expectedValuePaise: 250000 });
    expect(String(raviLead.productId)).toBe(String(product._id));
    expect(raviLead.createdAt.toISOString()).toBe('2026-02-01T09:00:00.000Z');
    expect(ravi.lifecycle).toBe('customer');

    // Won lead → its contact is a customer; the deal for the same shop reuses that contact.
    const meena = await Contact.findOne({ email: 'meena@stores.example' });
    expect(meena.lifecycle).toBe('customer');
    const diwali = await Lead.findOne({ legacyIds: 'd_big' });
    expect(diwali).toMatchObject({ title: 'Diwali order', stage: 'Quote Sent', expectedValuePaise: 5000000 });
    const lost = await Lead.findOne({ legacyIds: 'd_lost' });
    expect(lost.stage).toBe('Lost');
    expect(lost.lostReason).toMatch(/Imported/);
    const notes = await LeadActivity.find({ leadId: diwali._id, type: 'Note' });
    expect(notes.map((note) => note.text)).toEqual(['Sent price list']);

    const quotation = await Quotation.findOne({ legacyIds: 'q_1' });
    expect(quotation.totals.grandTotalPaise).toBe(262500); // 10 × ₹250 + 5% — not the browser's 999999
    expect(quotation.legacyNumber).toBe('QT-2026-0001');
    expect(quotation.number).toMatch(/^QT\/\d{4}-\d{2}\/0001$/);
  });

  it('running the import again creates nothing new', async () => {
    const before = await Promise.all([Contact.countDocuments(), Lead.countDocuments(), Quotation.countDocuments(), LeadActivity.countDocuments()]);
    const res = await run(false);
    const { sections } = res.body.data.report;
    expect(sections.products).toMatchObject({ created: 0, alreadyImported: 1 });
    expect(sections.leads).toMatchObject({ created: 0, alreadyImported: 3 });
    expect(sections.deals).toMatchObject({ created: 0, alreadyImported: 2 });
    expect(sections.quotations).toMatchObject({ created: 0, alreadyImported: 1 });
    const after = await Promise.all([Contact.countDocuments(), Lead.countDocuments(), Quotation.countDocuments(), LeadActivity.countDocuments()]);
    expect(after).toEqual(before);
  });

  it('is only for owners and admins, and needs CRM data', async () => {
    const agent = await inviteAndJoin(owner.token, 'import-agent@example.com');
    expect((await run(true, browserData(), agent.token)).status).toBe(403);
    const empty = await run(true, {});
    expect(empty.status).toBe(400);
  });

  it('keeps imported data inside the importing organization', async () => {
    const other = await login('import-other@example.com');
    const leads = await api().get('/api/v1/leads').set(bearer(other.token));
    expect(leads.body.data).toEqual([]);
  });
});
