jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Product = require('../models/Product');
const Quotation = require('../models/Quotation');
const LeadActivity = require('../models/LeadActivity');
const Task = require('../models/Task');
const CalendarEvent = require('../models/CalendarEvent');
const Ticket = require('../models/Ticket');
const Note = require('../models/Note');
const Document = require('../models/Document');
const Campaign = require('../models/Campaign');
const Workflow = require('../models/Workflow');
const Sequence = require('../models/Sequence');
const Invite = require('../models/Invite');
const { DEFAULT_MODULES } = require('../constants/permissions');
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
  crm_tasks: JSON.stringify([
    { id: 't_1', title: 'Call back', status: 'In Progress', priority: 'High', assignee: 'Rohan Local', dueDate: '2026-09-30', relatedType: 'Customer', relatedName: 'Ravi Traders' },
    { id: 't_2', title: 'Prepare samples', status: 'Done', assignee: 'Rohan Local', relatedType: 'Deal', relatedName: 'Diwali order' },
    { id: 't_bad', title: '' },
  ]),
  crm_deal_tasks: JSON.stringify([{ id: 'dt_1', text: 'Chase payment', done: true, due: '2026-09-28' }]),
  crm_calendar_events: JSON.stringify([
    { id: 'ev_1', title: 'Demo at shop', type: 'Demo', date: '2026-10-02', startTime: '15:00', endTime: '14:00', relatedType: 'Lead', relatedName: 'Sunita Stores' },
    { id: 'ev_2', title: 'No date' },
  ]),
  crm_tickets: JSON.stringify([
    { id: 'tk_1', number: 1001, subject: 'Late delivery', customer: 'Ravi Traders', category: 'Billing', priority: 'Urgent', status: 'Resolved', assignee: 'Rohan Local', dueDate: '2026-09-20', createdAt: '2026-09-01T10:00:00.000Z',
      notes: [{ text: 'Called the courier', at: '2026-09-02T10:00:00.000Z', author: 'Anil' }, { text: '' }] },
    { id: 'tk_2', number: 1002, subject: 'Need GST invoice', customer: 'Unknown Buyer', status: 'Weird' },
    { id: 'tk_nosubject', number: 1003 },
  ]),
  crm_customer_notes: JSON.stringify({ c_ravi: [{ text: 'VIP buyer', at: '2026-03-01T10:00:00.000Z', author: 'Anil' }], c_gone: [{ text: 'Old note' }] }),
  crm_documents: JSON.stringify([
    { id: 'doc_file', name: 'Price list', category: 'Proposal', owner: 'Priya Old', relatedType: 'Customer', relatedName: 'Ravi Traders', tags: ['2026', 'gst', 'gst'],
      fileName: 'price-list.txt', fileType: 'text/plain', fileSize: 5, fileData: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`, createdAt: '2026-05-01T10:00:00.000Z' },
    { id: 'doc_link', name: 'Catalogue', category: 'Report', linkUrl: 'drive.google.com/file/abc' },
    { id: 'doc_bad', name: 'Evil link', linkUrl: 'javascript:alert(1)' },
    { id: 'doc_exe', name: 'Tool', fileName: 'tool.exe', fileData: `data:application/octet-stream;base64,${Buffer.from('MZ').toString('base64')}` },
    { id: 'doc_empty', name: 'Nothing attached' },
  ]),
  crm_campaigns: JSON.stringify([
    { id: 'cm_1', name: 'Diwali offer', type: 'SMS', status: 'Active', startDate: '2026-10-15', endDate: '2026-10-01', budget: '5,000', leadsGenerated: '12', audience: 'Old buyers', owner: 'Priya Old',
      notes: [{ text: 'Approved by owner', at: '2026-09-20T10:00:00.000Z', author: 'Anil' }] },
    { id: 'cm_bad', name: '' },
  ]),
  crm_workflows: JSON.stringify([
    { id: 'wf_1', name: 'Welcome', status: 'Active', owner: 'Priya Old', trigger: 'Lead Created', runsCount: 4,
      actions: [{ type: 'Create Task', detail: 'Call within 1 hour' }, { type: 'Launch rocket', detail: 'x' }] },
    { id: 'wf_bad', name: 'Odd', trigger: 'Moon rises' },
  ]),
  crm_sequences: JSON.stringify([{ id: 'sq_1', name: 'New lead cadence', targetType: 'Leads', status: 'Paused', enrolledCount: 3,
    steps: [{ day: 0, type: 'Email', note: 'Hello' }, { day: 2, type: 'Call', note: 'Call them' }, { day: 'x', type: 'Call' }] }]),
  crm_agents: 'not json',
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
    expect(later).toEqual({});
    expect(sections.campaigns).toMatchObject({ found: 2, created: 1, rejected: 1 });
    expect(sections.campaignNotes).toMatchObject({ found: 1, created: 1 });
    expect(sections.workflows).toMatchObject({ found: 2, created: 1, rejected: 1 });
    expect(sections.sequences).toMatchObject({ found: 1, created: 1 });
    expect(sections.documents).toMatchObject({ found: 5, created: 2, rejected: 3 });
    expect(sections.tasks).toMatchObject({ found: 3, created: 2, rejected: 1 });
    expect(sections.events).toMatchObject({ found: 2, created: 1, rejected: 1 });
    expect(sections.tickets).toMatchObject({ found: 3, created: 2, rejected: 1 });
    expect(sections.ticketNotes).toMatchObject({ found: 2, created: 1, rejected: 1 });
    expect(sections.customerNotes).toMatchObject({ found: 2, created: 1, rejected: 1 });
    expect(problems).toEqual([{ key: 'crm_agents', reason: 'Not valid JSON' }]);
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

    // Tasks keep unknown assignees by name and link to the imported customer / deal.
    const callBack = await Task.findOne({ legacyIds: 't_1' });
    expect(callBack).toMatchObject({ status: 'In Progress', priority: 'High', dueDate: '2026-09-30', assigneeName: 'Rohan Local', relatedType: 'Customer', relatedName: 'Ravi Traders' });
    expect(String(callBack.relatedId)).toBe(String(ravi._id));
    const samples = await Task.findOne({ legacyIds: 't_2' });
    expect(String(samples.relatedId)).toBe(String(diwali._id));
    expect(samples.completedAt).toBeInstanceOf(Date);
    expect(unresolved.filter((note) => note.includes('Rohan Local'))).toHaveLength(1);

    const followUp = await Task.findOne({ legacyIds: 'dt_1' });
    expect(followUp).toMatchObject({ title: 'Chase payment', status: 'Done', dueDate: '2026-09-28', origin: 'deal_followup' });

    const demo = await CalendarEvent.findOne({ legacyIds: 'ev_1' });
    // End before start is dropped; "Sunita Stores" is no imported lead, so only the name is kept.
    expect(demo).toMatchObject({ type: 'Demo', date: '2026-10-02', startTime: '15:00', endTime: '', relatedType: 'Lead', relatedName: 'Sunita Stores' });
    expect(demo.relatedId).toBeUndefined();

    // Tickets keep their numbers and link to the imported customer; replies become notes.
    const late = await Ticket.findOne({ legacyIds: 'tk_1' });
    expect(late).toMatchObject({ number: 1001, customerName: 'Ravi Traders', category: 'Billing', priority: 'Urgent', status: 'Resolved', assigneeName: 'Rohan Local', dueDate: '2026-09-20' });
    expect(String(late.contactId)).toBe(String(ravi._id));
    expect(late.resolvedAt.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    const gst = await Ticket.findOne({ legacyIds: 'tk_2' });
    expect(gst).toMatchObject({ number: 1002, status: 'Open', customerName: 'Unknown Buyer' });
    expect(gst.contactId).toBeUndefined();
    const reply = await Note.findOne({ parentType: 'ticket', parentId: late._id });
    expect(reply).toMatchObject({ text: 'Called the courier', authorName: 'Anil' });
    expect(reply.createdAt.toISOString()).toBe('2026-09-02T10:00:00.000Z');
    const vip = await Note.findOne({ parentType: 'contact', parentId: ravi._id });
    expect(vip.text).toBe('VIP buyer');

    // Browser files go to private storage; links get https:// when it was missing.
    const priceList = await Document.findOne({ legacyIds: 'doc_file' });
    expect(priceList).toMatchObject({ category: 'Proposal', fileName: 'price-list.txt', mimeType: 'text/plain', sizeBytes: 5, relatedName: 'Ravi Traders' });
    expect([...priceList.tags]).toEqual(['2026', 'gst']);
    expect(String(priceList.relatedId)).toBe(String(ravi._id));
    expect(priceList.createdAt.toISOString()).toBe('2026-05-01T10:00:00.000Z');
    const got = await api().get(`/api/v1/documents/${priceList._id}/download`).set(bearer(owner.token)).buffer(true)
      .parse((stream, done) => { const chunks = []; stream.on('data', (c) => chunks.push(c)); stream.on('end', () => done(null, Buffer.concat(chunks))); });
    expect(got.body.toString()).toBe('hello');
    expect(unresolved.join(' ')).toMatch(/Priya Old/);
    expect((await Document.findOne({ legacyIds: 'doc_link' })).linkUrl).toBe('https://drive.google.com/file/abc');

    // New tickets continue after the imported numbers.
    const next = await api().post('/api/v1/tickets').set(bearer(owner.token)).send({ subject: 'After import' });
    expect(next.body.data.number).toBe(1004);

    // Campaign budget in paise, an end date before the start is dropped; automations keep their counts.
    const diwaliOffer = await Campaign.findOne({ legacyIds: 'cm_1' });
    expect(diwaliOffer).toMatchObject({ type: 'SMS', status: 'Active', startDate: '2026-10-15', budgetPaise: 500000, leadsGenerated: 12, audience: 'Old buyers' });
    expect(diwaliOffer.endDate).toBeUndefined();
    expect((await Note.findOne({ parentType: 'campaign', parentId: diwaliOffer._id })).text).toBe('Approved by owner');
    const welcome = await Workflow.findOne({ legacyIds: 'wf_1' });
    expect(welcome).toMatchObject({ trigger: 'Lead Created', status: 'Active', runsCount: 4 });
    expect(welcome.actions.map((a) => a.type)).toEqual(['Create Task']);
    expect(unresolved.join(' ')).toMatch(/Welcome.*1 unknown action/);
    const cadence = await Sequence.findOne({ legacyIds: 'sq_1' });
    expect(cadence).toMatchObject({ status: 'Paused', enrolledCount: 3 });
    expect(cadence.steps.map((st) => `${st.day}:${st.type}`)).toEqual(['0:Email', '2:Call']);
  });

  it('running the import again creates nothing new, and does not bring back deleted records', async () => {
    const gst = await Ticket.findOne({ legacyIds: 'tk_2' });
    await api().delete(`/api/v1/tickets/${gst._id}`).set(bearer(owner.token));
    const callBack = await Task.findOne({ legacyIds: 't_1' });
    await api().delete(`/api/v1/tasks/${callBack._id}`).set(bearer(owner.token));
    const counts = () => Promise.all([Contact.countDocuments(), Lead.countDocuments(), Quotation.countDocuments(), LeadActivity.countDocuments(), Task.countDocuments(), CalendarEvent.countDocuments(), Ticket.countDocuments(), Note.countDocuments(), Document.countDocuments(), Campaign.countDocuments(), Workflow.countDocuments(), Sequence.countDocuments()]);
    const before = await counts();
    const res = await run(false);
    const { sections } = res.body.data.report;
    expect(sections.products).toMatchObject({ created: 0, alreadyImported: 1 });
    expect(sections.leads).toMatchObject({ created: 0, alreadyImported: 3 });
    expect(sections.deals).toMatchObject({ created: 0, alreadyImported: 2 });
    expect(sections.quotations).toMatchObject({ created: 0, alreadyImported: 1 });
    expect(sections.tasks).toMatchObject({ created: 0, alreadyImported: 2 });
    expect(sections.events).toMatchObject({ created: 0, alreadyImported: 1 });
    expect(sections.tickets).toMatchObject({ created: 0, alreadyImported: 2 });
    expect(sections.ticketNotes).toMatchObject({ created: 0, alreadyImported: 1 });
    expect(sections.customerNotes).toMatchObject({ created: 0, alreadyImported: 1 });
    expect(sections.documents).toMatchObject({ created: 0, alreadyImported: 2 });
    expect(sections.campaigns).toMatchObject({ created: 0, alreadyImported: 1 });
    expect(sections.campaignNotes).toMatchObject({ created: 0, alreadyImported: 1 });
    expect(sections.workflows).toMatchObject({ created: 0, alreadyImported: 1 });
    expect(sections.sequences).toMatchObject({ created: 0, alreadyImported: 1 });
    const after = await counts();
    expect(after).toEqual(before);
  });

  it('turns Account Champions into invites: never admins, current members left alone', async () => {
    const shop = await login('import-team@example.com');
    await inviteAndJoin(shop.token, 'already@example.com');
    const data = { crm_agents: JSON.stringify([
      { id: 'ag_1', name: 'Rohan Mehta', email: 'Rohan@Example.com', mobile: '+91 98765 43210', role: 'Sales',
        modules: ['Leads', 'Deals', 'Sales Automation', 'Unknown Page'], permissions: ['View', 'Create', 'Edit', 'Delete'] },
      { id: 'ag_2', name: 'Vani', email: 'vani@example.com', role: 'Support', modules: [], permissions: ['View'] },
      { id: 'ag_3', name: 'Already Here', email: 'already@example.com', permissions: ['View'] },
      { id: 'ag_4', name: 'No Mail', permissions: ['View', 'Create'] },
    ]) };

    const preview = await run(true, data, shop.token);
    expect(preview.body.data.report.sections.teamInvites).toMatchObject({ found: 4, created: 2, alreadyImported: 1, rejected: 1 });
    expect(preview.body.data.report.sections.teamInvites.rejectedRows[0].reason).toMatch(/No Mail has no valid email/);
    expect(await Invite.countDocuments({ email: 'rohan@example.com' })).toBe(0);

    await run(false, data, shop.token);
    const rohan = await Invite.findOne({ email: 'rohan@example.com' });
    expect(rohan).toMatchObject({ role: 'agent', status: 'pending', displayName: 'Rohan Mehta', mobile: '+91 98765 43210', title: 'Sales' });
    expect([...rohan.modules]).toEqual(['leads', 'deals', 'automation']);
    expect([...rohan.permissions]).toEqual(['leads:delete', 'deals:delete', 'automation:delete']);
    expect(rohan.tokenHash).toBeUndefined(); // no link was made; signing in with that email is enough
    const vani = await Invite.findOne({ email: 'vani@example.com' });
    expect(vani).toMatchObject({ role: 'viewer', title: 'Support' });
    expect([...vani.modules]).toEqual([...DEFAULT_MODULES.viewer]);

    await login('rohan@example.com', { name: 'rohan.g' });
    const joined = (await api().get('/api/v1/members').set(bearer(shop.token))).body.data.find((m) => m.email === 'rohan@example.com');
    expect(joined).toMatchObject({ name: 'Rohan Mehta', title: 'Sales', role: 'agent', mobile: '+91 98765 43210' });

    const again = await run(false, data, shop.token);
    expect(again.body.data.report.sections.teamInvites).toMatchObject({ created: 0, alreadyImported: 3, rejected: 1 });
  });

  it('renumbers an old ticket whose number is taken and keeps the old number', async () => {
    const shop = await login('import-numbers@example.com');
    expect((await api().post('/api/v1/tickets').set(bearer(shop.token)).send({ subject: 'Made on the server' })).body.data.number).toBe(1001);
    const data = { crm_tickets: JSON.stringify([{ id: 'old_a', number: 1001, subject: 'Old A' }, { id: 'old_b', number: 1005, subject: 'Old B' }]) };
    expect((await run(false, data, shop.token)).status).toBe(201);
    const oldA = await Ticket.findOne({ legacyIds: 'old_a' });
    expect(oldA).toMatchObject({ number: 1006, legacyNumber: 1001 });
    expect((await Ticket.findOne({ legacyIds: 'old_b' })).number).toBe(1005);
    expect((await api().post('/api/v1/tickets').set(bearer(shop.token)).send({ subject: 'Next' })).body.data.number).toBe(1007);
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
