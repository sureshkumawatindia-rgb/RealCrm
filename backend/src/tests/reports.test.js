jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const Broadcast = require('../models/Broadcast');
const BroadcastRecipient = require('../models/BroadcastRecipient');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const LeadIntake = require('../models/LeadIntake');
const Message = require('../models/Message');
const Organization = require('../models/Organization');
const PaymentConnection = require('../models/PaymentConnection');
const PaymentLink = require('../models/PaymentLink');
const Quotation = require('../models/Quotation');
const Task = require('../models/Task');
const { rangeOf, bucketOf, bucketsOf } = require('../utils/reportRange');
const { csvCell } = require('../services/reportService');
const { indiaDate } = require('../utils/dates');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 9A: reports counted from the records for a range of days in India — overview, trend,
// agent performance (response times from the messages, D46), sources, quotations, broadcasts,
// payments, the dashboard and insights, CSV export; and who sees what (D45).
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('Report ranges', () => {
  it('are days in India, both ends included, with buckets that fit the length', () => {
    const r = rangeOf({ from: '2026-10-01', to: '2026-10-07' });
    expect(r).toMatchObject({ from: '2026-10-01', to: '2026-10-07', days: 7, unit: 'day' });
    expect(r.start.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(r.end.toISOString()).toBe('2026-10-07T18:30:00.000Z');
    expect(rangeOf({ from: '2026-01-01', to: '2026-06-30' }).unit).toBe('week');
    expect(rangeOf({ from: '2025-10-01', to: '2026-09-30' }).unit).toBe('month');
    expect(rangeOf({}).days).toBe(30);
    expect(rangeOf({ to: '2026-10-07' }).from).toBe('2026-09-08');
    expect(bucketOf(new Date('2026-10-07T20:00:00Z'), 'day')).toBe('2026-10-08'); // 01:30 IST next day
    expect(bucketOf(new Date('2026-10-07T06:00:00Z'), 'week')).toBe('2026-10-05'); // a Wednesday → its Monday
    expect(bucketOf(new Date('2026-10-07T06:00:00Z'), 'month')).toBe('2026-10');
    expect(bucketsOf(r)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
    expect(() => rangeOf({ from: '2026-10-08', to: '2026-10-01' })).toThrow('not valid');
    expect(() => rangeOf({ from: '2020-01-01', to: '2026-10-01' })).toThrow('three years');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('Ravi, Jaipur')).toBe('"Ravi, Jaipur"');
    expect(csvCell(-5)).toBe("'-5"); // never a formula, even a negative number
  });
});

describe('Reports', () => {
  let owner;
  let arun; // agent with Reports
  let bela; // agent without Reports
  let ids;
  const as = (user) => bearer(user.token);
  const get = (user, path) => api().get(`/api/v1${path}`).set(as(user));
  const post = (user, path, body) => api().post(`/api/v1${path}`).set(as(user)).send(body);
  const now = Date.now();
  const at = (ms) => new Date(now - ms);

  beforeAll(async () => {
    owner = await login('reports-owner@example.com', { name: 'Asha' });
    arun = await inviteAndJoin(owner.token, 'reports-arun@example.com', { role: 'agent', displayName: 'Arun', modules: ['inbox', 'leads', 'deals', 'reports', 'dashboard', 'insights'] });
    bela = await inviteAndJoin(owner.token, 'reports-bela@example.com', { role: 'agent', displayName: '=Bela', modules: ['inbox', 'leads', 'deals', 'dashboard'] });
    await api().patch('/api/v1/organization').set(as(owner)).send({ name: 'Yellow Traders', gstin: '08AAACY1234C1Z5' });
    await post(owner, '/whatsapp/accounts', { provider: 'mock' });
    const members = (await get(owner, '/members')).body.data;
    ids = Object.fromEntries(members.map((m) => [m.email.split('@')[0].replace('reports-', ''), m.id]));

    // --- Chats: a customer waits 10 minutes for Arun (a bot reply in between does not count),
    // later 30 minutes for Bela; another customer is still waiting (3 hours). ---
    const one = (await post(owner, '/dev/simulate/whatsapp-inbound', { from: '98290 61001', name: 'Ravi Traders', text: 'Rate?' })).body.data;
    await post(arun, `/conversations/${one.conversationId}/messages`, { type: 'text', text: 'Namaste, sending rates.' });
    const [firstIn] = await Message.find({ conversationId: one.conversationId, direction: 'in' });
    const [arunOut] = await Message.find({ conversationId: one.conversationId, direction: 'out' });
    // createdAt is immutable in Mongoose: test data moves it in the collection itself.
    await Message.collection.updateOne({ _id: firstIn._id }, { $set: { createdAt: at(5 * HOUR), providerTimestamp: at(5 * HOUR) } });
    await Message.collection.updateOne({ _id: arunOut._id }, { $set: { createdAt: at(5 * HOUR - 10 * MIN) } });
    await Message.create({ organizationId: firstIn.organizationId, conversationId: firstIn.conversationId, contactId: firstIn.contactId, whatsappAccountId: firstIn.whatsappAccountId, direction: 'out', type: 'text', text: 'Bot', status: 'sent', automation: { kind: 'bot' }, createdAt: at(5 * HOUR - 1 * MIN) });
    await Message.create({ organizationId: firstIn.organizationId, conversationId: firstIn.conversationId, contactId: firstIn.contactId, whatsappAccountId: firstIn.whatsappAccountId, direction: 'in', type: 'text', text: 'And jeera?', status: 'received', providerMessageId: 'wamid.REP1', createdAt: at(4 * HOUR), providerTimestamp: at(4 * HOUR) });
    await Message.create({ organizationId: firstIn.organizationId, conversationId: firstIn.conversationId, contactId: firstIn.contactId, whatsappAccountId: firstIn.whatsappAccountId, direction: 'out', type: 'text', text: 'Yes', status: 'sent', sentByMemberId: ids.bela, createdAt: at(4 * HOUR - 30 * MIN) });
    const two = (await post(owner, '/dev/simulate/whatsapp-inbound', { from: '98290 61002', name: 'Kiran Stores', text: 'Hello?' })).body.data;
    await Message.collection.updateMany({ conversationId: new mongoose.Types.ObjectId(two.conversationId) }, { $set: { createdAt: at(3 * HOUR), providerTimestamp: at(3 * HOUR) } });
    await Conversation.updateOne({ _id: two.conversationId }, { $set: { lastInboundAt: at(3 * HOUR) } });

    // --- Leads: Arun's are won and lost; a Website lead of Bela's is quoted; an old idle one. ---
    const lead = async (name, source, ownerId, extra = {}) => (await post(owner, '/leads', { contact: { name, phone: `98290 6${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}` }, source, ownerId, ...extra })).body.data;
    const won = await lead('Meena Spices', 'IndiaMART', ids.arun, { expectedValuePaise: 5000000 });
    const lost = await lead('Small Shop', 'IndiaMART', ids.arun);
    const quoted = await lead('Bhavya Mart', 'Website', ids.bela, { expectedValuePaise: 2000000 });
    const idle = await lead('Old Enquiry', 'Website', null, { expectedValuePaise: 9000000 });
    await Lead.updateOne({ _id: won.id }, { $set: { stage: 'Won', stageChangedAt: at(2 * DAY) } });
    await Lead.updateOne({ _id: lost.id }, { $set: { stage: 'Lost', lostReason: 'Price', stageChangedAt: at(1 * DAY) } });
    await Lead.updateOne({ _id: quoted.id }, { $set: { stage: 'Quote Sent', lastActivityAt: at(8 * DAY) } });
    await Lead.collection.updateOne({ _id: new mongoose.Types.ObjectId(idle.id) }, { $set: { stage: 'Negotiation', createdAt: at(60 * DAY), lastActivityAt: at(20 * DAY) } });
    const org = await Organization.findOne({ name: 'Yellow Traders' });
    await LeadIntake.create([
      { organizationId: org._id, source: 'IndiaMART', sourceRef: 'im-1', outcome: 'created', receivedAt: at(2 * DAY) },
      { organizationId: org._id, source: 'IndiaMART', sourceRef: 'im-2', outcome: 'attached', receivedAt: at(2 * DAY) },
      { organizationId: org._id, source: 'IndiaMART', sourceRef: 'im-3', outcome: 'created', receivedAt: at(1 * DAY) },
    ]);

    // --- A quotation of Arun's accepted, made an order and paid in part by bank transfer;
    // Bela's quotation rejected. ---
    const product = (await post(owner, '/products', { name: 'Jeera 25kg', pricePaise: 100000, gstRatePct: 18 })).body.data;
    const q1 = (await post(owner, '/quotations', { leadId: won.id, items: [{ productId: product.id, quantity: 10 }] })).body.data; // ₹11,800
    await api().patch(`/api/v1/quotations/${q1.id}`).set(as(owner)).send({ status: 'Sent' });
    await api().patch(`/api/v1/quotations/${q1.id}`).set(as(owner)).send({ status: 'Accepted' });
    const order = (await post(owner, '/orders', { quotationId: q1.id })).body.data;
    await post(owner, `/orders/${order.id}/payments`, { amountPaise: 500000, method: 'bank_transfer', reference: 'UTR1' });
    const q2 = (await post(owner, '/quotations', { leadId: quoted.id, items: [{ productId: product.id, quantity: 5 }] })).body.data;
    await api().patch(`/api/v1/quotations/${q2.id}`).set(as(owner)).send({ status: 'Sent' });
    await api().patch(`/api/v1/quotations/${q2.id}`).set(as(owner)).send({ status: 'Rejected', rejectedReason: 'Price too high' });
    await Quotation.updateOne({ _id: q1.id }, { $set: { sentAt: at(3 * DAY), acceptedAt: at(2 * DAY) } });
    // A paid payment link of the test gateway.
    const conn = await PaymentConnection.create({ organizationId: org._id, provider: 'mock', webhookKey: 'a'.repeat(32) });
    await PaymentLink.create({ organizationId: org._id, connectionId: conn._id, provider: 'mock', referenceId: 'ycrm_r1', providerLinkId: 'mock_plink_r1', purpose: 'order', orderId: order.id, ownerId: ids.arun, amountPaise: 680000, amountPaidPaise: 680000, status: 'paid', createdAt: at(10 * HOUR), paidAt: at(4 * HOUR) });

    // --- Work: a task done by Arun, one due today for Bela; a broadcast. ---
    await Task.create({ organizationId: org._id, title: 'Call Meena', assigneeId: ids.arun, status: 'Done', completedAt: at(1 * HOUR), dueDate: indiaDate(0) });
    await Task.create({ organizationId: org._id, title: 'Send samples', assigneeId: ids.bela, status: 'To Do', dueDate: indiaDate(0) });
    const broadcast = await Broadcast.create({ organizationId: org._id, name: 'Diwali offer', status: 'completed', templateId: new mongoose.Types.ObjectId(), templateName: 'diwali_offer', segmentId: new mongoose.Types.ObjectId(), startedAt: at(2 * DAY) });
    await BroadcastRecipient.create([
      { organizationId: org._id, broadcastId: broadcast._id, contactId: firstIn.contactId, phoneE164: '+919829061001', status: 'replied', sentAt: at(2 * DAY), deliveredAt: at(2 * DAY), readAt: at(2 * DAY), repliedAt: at(2 * DAY) },
      { organizationId: org._id, broadcastId: broadcast._id, contactId: two.contactId, phoneE164: '+919829061002', status: 'delivered', sentAt: at(2 * DAY), deliveredAt: at(2 * DAY) },
      { organizationId: org._id, broadcastId: broadcast._id, contactId: new mongoose.Types.ObjectId(), phoneE164: '+919829061003', status: 'failed', reason: 'Not on WhatsApp' },
    ]);
  });

  it('gives the company overview and the trend for a range', async () => {
    const o = (await get(owner, '/reports/overview')).body.data;
    expect(o).toMatchObject({
      scope: 'company',
      // 3 leads made here + 2 WhatsApp leads of the two chats; the 60-day-old lead is outside the last 30 days.
      leads: { created: 5, won: 1, lost: 1, winRatePct: 50 },
      quotations: { sent: 2, accepted: 1 },
      orders: { count: 1, valuePaise: 1180000 },
      payments: { collectedPaise: 500000, count: 1 },
      pipeline: { open: 4, valuePaise: 11000000 },
      dues: { orders: 1, duePaise: 680000 },
      whatsapp: { newChats: 2, replies: 2, firstResponseMedianSeconds: 600, responseMedianSeconds: 1200, responseAverageSeconds: 1200 },
    });
    expect((await get(owner, `/reports/overview?from=${indiaDate(-1)}&to=${indiaDate(0)}`)).body.data.leads).toMatchObject({ won: 0, lost: 1 });
    expect((await get(owner, '/reports/overview?from=2026-10-09&to=2026-10-01')).status).toBe(400);
    const t = (await get(owner, `/reports/trend?from=${indiaDate(-6)}&to=${indiaDate(0)}`)).body.data;
    expect(t.range.unit).toBe('day');
    expect(t.items).toHaveLength(7);
    expect(t.items.reduce((s, r) => s + r.won, 0)).toBe(1);
    expect(t.items.reduce((s, r) => s + r.collectedPaise, 0)).toBe(500000);
    expect(t.items.at(-1)).toMatchObject({ bucket: indiaDate(0) });
  });

  it('measures agent performance: response times, chats, leads, money, work', async () => {
    const a = (await get(owner, '/reports/agents')).body.data;
    const rows = Object.fromEntries(a.items.map((r) => [r.name, r]));
    expect(rows.Arun).toMatchObject({
      chatsHandled: 1, messagesSent: 1, replies: 1, firstResponseMedianSeconds: 600, responseMedianSeconds: 600,
      won: 1, lost: 1, winRatePct: 50, quotationsSent: 1, quotationsAccepted: 1, orders: 1, orderValuePaise: 1180000, collectedPaise: 500000, tasksDone: 1,
    });
    expect(rows.Arun.leadsByStage).toMatchObject({ Won: 1, Lost: 1 });
    expect(rows['=Bela']).toMatchObject({ chatsHandled: 1, replies: 1, responseMedianSeconds: 1800, firstResponseMedianSeconds: null, leadsByStage: { 'Quote Sent': 1 }, quotationsSent: 1, quotationsAccepted: 0 });
    expect(rows.Asha).toBeDefined(); // every active member is listed
    expect(a.team).toMatchObject({ replies: 2, responseMedianSeconds: 1200, firstResponseMedianSeconds: 600, won: 1, collectedPaise: 500000 });

    // D45: an agent with Reports sees only their own row; without Reports, none.
    const mine = (await get(arun, '/reports/agents')).body.data;
    expect(mine.scope).toBe('own');
    expect(mine.items.map((r) => r.name)).toEqual(['Arun']);
    // Arun's: won, lost, and Ravi's WhatsApp lead (his reply took it, D25).
    expect((await get(arun, '/reports/overview')).body.data).toMatchObject({ scope: 'own', leads: { created: 3, won: 1 }, quotations: { sent: 1 } });
    expect((await get(bela, '/reports/agents')).status).toBe(403);
  });

  it('shows where leads come from, how quotations do, broadcasts and payments', async () => {
    const s = (await get(owner, '/reports/sources')).body.data;
    const bySource = Object.fromEntries(s.items.map((r) => [r.source, r]));
    expect(bySource.IndiaMART).toMatchObject({ enquiries: 3, repeatEnquiries: 1, leads: 2, funnel: { created: 2, won: 1 }, conversionPct: 50 });
    expect(bySource.Website).toMatchObject({ leads: 1, funnel: { created: 1, contacted: 1, quoted: 1, won: 0 } });
    expect(bySource.WhatsApp).toMatchObject({ leads: 2, funnel: { created: 2, contacted: 0 } });
    expect(s.totals).toMatchObject({ leads: 5, won: 1, conversionPct: 20 });

    const q = (await get(owner, '/reports/quotations')).body.data;
    expect(q.totals).toMatchObject({ sent: 2, accepted: 1, rejected: 1, winRatePct: 50, acceptedValuePaise: 1180000, averageDaysToAccept: 1 });
    expect(q.rejectionReasons).toEqual([{ reason: 'Price too high', count: 1 }]);
    expect(q.byOwner.map((r) => [r.name, r.accepted])).toEqual(expect.arrayContaining([['Arun', 1], ['=Bela', 0]]));

    const b = (await get(owner, '/reports/broadcasts')).body.data;
    expect(b.items).toEqual([expect.objectContaining({ name: 'Diwali offer', total: 3, sent: 2, delivered: 2, read: 1, replied: 1, failed: 1, deliveredPct: 100, readPct: 50, repliedPct: 50 })]);
    expect((await get(arun, '/reports/broadcasts')).body.data.items).toEqual([]); // owners and admins (D36)

    const p = (await get(owner, '/reports/payments')).body.data;
    expect(p).toMatchObject({ collected: { amountPaise: 500000, count: 1 }, links: { made: 1, paid: 1, averageHoursToPay: 6 }, dues: { count: 1, duePaise: 680000 } });
    expect(p.byWay).toEqual([{ name: 'By hand · Bank transfer', count: 1, amountPaise: 500000 }]);
  });

  it('gives the dashboard and the insights from the records', async () => {
    const d = (await get(owner, '/reports/dashboard')).body.data;
    expect(d).toMatchObject({
      scope: 'company', chats: { waitingForReply: 1, unassigned: expect.any(Number) }, pipeline: { open: 4, valuePaise: 11000000 },
      payments: { collectedMonthPaise: expect.any(Number), dueOrders: 1, duePaise: 680000 }, tasks: { dueToday: 1 },
    });
    expect(d.chats.longestWaitMinutes).toBeGreaterThanOrEqual(179);
    expect((await get(bela, '/reports/dashboard')).body.data).toMatchObject({ scope: 'own', tasks: { dueToday: 1 }, pipeline: { open: 1 } });

    const i = (await get(owner, '/reports/insights')).body.data;
    expect(i.pipeline).toMatchObject({ open: 4, valuePaise: 11000000, weightedPaise: 9000000 * 0.75 + 2000000 * 0.5 });
    expect(i.atRisk.items.map((l) => [l.customer, l.idleDays])).toEqual([['Old Enquiry', 20], ['Bhavya Mart', 8]]);
    // The old enquiry and Kiran's WhatsApp lead have no owner.
    expect(i).toMatchObject({ unassignedLeads: 2, negotiation: { count: 1, valuePaise: 9000000 }, last90Days: { won: 1, lost: 1, winRatePct: 50 } });
    expect(i.priority[0]).toMatchObject({ customer: 'Old Enquiry', stage: 'Negotiation', nextStep: 'Close: send a payment link' });
    expect(i.slowChats).toEqual([expect.objectContaining({ customer: 'Kiran Stores', waitingHours: 3 })]);
    expect((await get(bela, '/reports/insights')).status).toBe(403);
  });

  it('exports CSV files that spreadsheets cannot turn into formulas', async () => {
    const res = await api().get('/api/v1/reports/export?type=agents').set(as(owner)).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="report-agents-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = res.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Member,Chats handled,Messages sent');
    expect(text).toMatch(/\r\n'=Bela,1,1,1,,30\.0,30\.0,/);
    expect(text).toMatch(/\r\nArun,1,1,1,10\.0,10\.0,10\.0,3,/);
    for (const type of ['overview', 'trend', 'sources', 'quotations', 'broadcasts', 'payments']) {
      expect((await api().get(`/api/v1/reports/export?type=${type}`).set(as(owner))).status).toBe(200);
    }
    expect((await api().get('/api/v1/reports/export?type=secrets').set(as(owner))).status).toBe(400);
  });

  it('shows another company nothing', async () => {
    const stranger = await login('reports-stranger@example.com');
    expect((await get(stranger, '/reports/overview')).body.data).toMatchObject({ leads: { created: 0 }, orders: { count: 0 }, payments: { collectedPaise: 0 }, whatsapp: { newChats: 0, replies: 0 } });
    expect((await get(stranger, '/reports/agents')).body.data.items.map((r) => r.name)).toEqual(['reports-stranger']);
    expect((await get(stranger, '/reports/broadcasts')).body.data.items).toEqual([]);
    expect((await get(stranger, '/reports/insights')).body.data.pipeline.open).toBe(0);
  });
});
