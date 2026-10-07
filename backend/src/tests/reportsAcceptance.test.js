jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const jobs = require('../jobs');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const Order = require('../models/Order');
const inbound = require('../services/whatsappInboundService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 9 acceptance (brief, test 5): the admin opens the agent performance report. Through the
// real code: customers write through signed WhatsApp webhooks (Meta faked at fetch), two agents
// answer, one sells (quotation, payment link of the test gateway, paid through its page, the job
// worker records it); the admin's report shows each agent's reply times, chats, wins and money,
// downloads as CSV, and the agents and another company see only what they may.
const APP_SECRET = 'p9-app-secret-0123456789';
const PHONE_NUMBER_ID = '5550006666';
const WABA_ID = '4440006666';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sign = (raw) => `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function until(check, what, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe('Phase 9 acceptance: the admin opens the agent performance report', () => {
  let sends = 0;
  beforeAll(() => {
    jest.spyOn(global, 'fetch').mockImplementation(async (target, options = {}) => {
      const url = String(target);
      if (url.includes('/message_templates')) return json({ data: [] });
      if (url.endsWith(`/${PHONE_NUMBER_ID}/messages`) && options.method === 'POST') {
        sends += 1;
        return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.P9OUT${sends}` }] });
      }
      return json({ display_phone_number: '+91 90000 66666', verified_name: 'Yellow Traders', quality_rating: 'GREEN' });
    });
  });
  afterAll(async () => {
    await jobs.stop();
    jest.restoreAllMocks();
  });

  it('shows each agent\'s reply times, chats, wins and money — to the right people', async () => {
    // --- The company: an admin, Arun (with Reports), Bela (without), WhatsApp, a test gateway ---
    const owner = await login('p9-owner@example.com', { name: 'Asha' });
    const arun = await inviteAndJoin(owner.token, 'p9-arun@example.com', { role: 'agent', displayName: 'Arun', modules: ['inbox', 'leads', 'deals', 'products', 'reports'] });
    const bela = await inviteAndJoin(owner.token, 'p9-bela@example.com', { role: 'agent', displayName: 'Bela', modules: ['inbox', 'leads', 'deals'] });
    const stranger = await login('p9-stranger@example.com');
    const as = (user) => bearer(user.token);
    const post = (user, path, body) => api().post(`/api/v1${path}`).set(as(user)).send(body);
    const get = (user, path) => api().get(`/api/v1${path}`).set(as(user));
    await api().patch('/api/v1/organization').set(as(owner)).send({ name: 'Yellow Traders', gstin: '08AAACY1234C1Z5' });
    const account = (await post(owner, '/whatsapp/accounts', { name: 'Sales', phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: 'EAAG-p9-token-1122', appSecret: APP_SECRET })).body.data;
    await post(owner, '/payments/connections', { provider: 'mock' });
    const product = (await post(owner, '/products', { name: 'Jeera 25kg', pricePaise: 300000, gstRatePct: 5 })).body.data;
    jobs.start({ pollMs: 200 });
    const customerWrote = async (waId, name, text, minutesAgo) => {
      const raw = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_NUMBER_ID }, contacts: [{ profile: { name }, wa_id: waId }], messages: [{ from: waId, id: `wamid.P9IN${crypto.randomBytes(6).toString('hex')}`, timestamp: String(Math.floor((Date.now() - minutesAgo * 60000) / 1000)), type: 'text', text: { body: text } }] } }] }],
      });
      expect((await api().post(account.webhookPath).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw)).send(raw)).status).toBe(200);
      await inbound.idle();
      return Conversation.findOne({ whatsappAccountId: account.id }).sort({ createdAt: -1 });
    };

    // --- Two customers write (WhatsApp says when: 10 and 25 minutes ago); Arun and Bela answer now ---
    const ravi = await customerWrote('919829071001', 'Ravi Traders', 'Jeera 10 bag ka rate?', 10);
    const kiran = await customerWrote('919829071002', 'Kiran Stores', 'Haldi hai?', 25);
    expect((await post(arun, `/conversations/${ravi._id}/messages`, { type: 'text', text: 'Namaste! ₹3,000 per bag + 5% GST.' })).status).toBe(201);
    expect((await post(bela, `/conversations/${kiran._id}/messages`, { type: 'text', text: 'Ji haan, available.' })).status).toBe(201);

    // --- Arun sells: quotation, accepted, order, payment link paid through the test gateway ---
    const quotation = (await post(arun, '/quotations', { conversationId: String(ravi._id), items: [{ productId: product.id, quantity: 10 }] })).body.data; // ₹31,500
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(as(arun)).send({ status: 'Sent' });
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(as(arun)).send({ status: 'Accepted' });
    const order = (await post(arun, '/orders', { quotationId: quotation.id })).body.data;
    const link = (await post(arun, '/payment-links', { orderId: order.id })).body.data;
    expect((await api().post(new URL(link.shortUrl).pathname).type('form').send({})).status).toBe(200);
    await until(async () => (await Order.findById(order.id)).amountPaidPaise === 3150000, 'the payment');
    await until(async () => (await Lead.findOne({ contactId: ravi.contactId })).stage === 'Won', 'the won lead');

    // --- The admin opens the agent performance report ------------------------------------------
    const report = await get(owner, '/reports/agents');
    expect(report.status).toBe(200);
    const rows = Object.fromEntries(report.body.data.items.map((r) => [r.name, r]));
    expect(report.body.data.scope).toBe('company');
    expect(rows.Arun).toMatchObject({ chatsHandled: 1, messagesSent: 1, replies: 1, won: 1, winRatePct: 100, quotationsSent: 1, quotationsAccepted: 1, orders: 1, orderValuePaise: 3150000, collectedPaise: 3150000 });
    expect(rows.Arun.firstResponseMedianSeconds).toBeGreaterThanOrEqual(595);
    expect(rows.Arun.firstResponseMedianSeconds).toBeLessThan(660);
    expect(rows.Bela).toMatchObject({ chatsHandled: 1, replies: 1, won: 0, collectedPaise: 0 });
    expect(rows.Bela.firstResponseMedianSeconds).toBeGreaterThanOrEqual(1495);
    expect(rows.Bela.firstResponseMedianSeconds).toBeLessThan(1560);
    expect(rows.Asha).toMatchObject({ chatsHandled: 0, replies: 0 });
    expect(report.body.data.team).toMatchObject({ replies: 2, won: 1, collectedPaise: 3150000 });
    // The same report as a file, and the overview it belongs to.
    const csv = await api().get('/api/v1/reports/export?type=agents').set(as(owner));
    expect(csv.status).toBe(200);
    expect(csv.text).toMatch(/\r\nArun,1,1,1,1\d\.\d,1\d\.\d,/);
    expect((await get(owner, '/reports/overview')).body.data).toMatchObject({ leads: { created: 2, won: 1 }, payments: { collectedPaise: 3150000 }, whatsapp: { newChats: 2, replies: 2 } });
    expect((await get(owner, '/reports/dashboard')).body.data).toMatchObject({ chats: { waitingForReply: 0 }, payments: { collectedMonthPaise: 3150000 } });

    // --- Nobody else sees the company's figures ----------------------------------------------------
    const mine = (await get(arun, '/reports/agents')).body.data;
    expect(mine).toMatchObject({ scope: 'own' });
    expect(mine.items.map((r) => r.name)).toEqual(['Arun']);
    expect((await get(bela, '/reports/agents')).status).toBe(403);
    expect((await get(bela, '/reports/export?type=agents')).status).toBe(403);
    const theirs = (await get(stranger, '/reports/agents')).body.data;
    expect(theirs.items.map((r) => r.name)).toEqual(['p9-stranger']);
    expect(theirs.team).toMatchObject({ replies: 0, collectedPaise: 0 });
  }, 120000);
});
