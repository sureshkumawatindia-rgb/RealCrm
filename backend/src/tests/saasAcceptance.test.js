jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const jobs = require('../jobs');
const Organization = require('../models/Organization');
const Lead = require('../models/Lead');
const BillingInvoice = require('../models/BillingInvoice');
const Notification = require('../models/Notification');
const safeWebhook = require('../utils/safeWebhook');
const ai = require('../services/aiService');
const deletion = require('../services/organizationDeletionService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 10 acceptance: a company lives its SaaS life through the real code and the real job
// worker. It signs up (30-day trial), pays for Pro on the test gateway (GST invoice), outgrows
// it and upgrades to Growth for the API, connects its ERP (API key + signed webhook), takes a
// lead from the ERP, gets an AI reply suggestion, gets a phone notification, downloads all its
// data, and finally deletes itself after the waiting period.
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
const b64u = (buffer) => Buffer.from(buffer).toString('base64url');

describe('Phase 10 acceptance: the SaaS life of a company', () => {
  const erpCalls = [];
  const pushCalls = [];
  beforeAll(() => {
    safeWebhook.setLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
    jest.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const target = String(url);
      if (target.startsWith('https://erp.example.com/')) {
        erpCalls.push({ headers: options.headers, body: options.body });
        return new Response('ok', { status: 200 });
      }
      if (target.startsWith('https://push.example.com/')) {
        pushCalls.push({ headers: options.headers });
        return new Response('', { status: 201 });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const answer = async (params) => ({
      model: params.model, stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000 },
      parsed_output: { suggestions: ['Namaste! Jeera 25kg ₹3,000 per bag + 5% GST.'], note: '' },
    });
    ai.setClient({ messages: { parse: answer }, beta: { messages: { parse: answer } } });
    jobs.start({ pollMs: 150 });
  });
  afterAll(async () => {
    await jobs.stop();
    jest.restoreAllMocks();
    safeWebhook.setLookup((hostname) => require('dns').promises.lookup(hostname, { all: true, verbatim: true }));
  });

  it('signs up, pays, connects its ERP, sells with AI help, exports and leaves', async () => {
    const as = (user) => bearer(user.token);
    const post = (user, path, body) => api().post(`/api/v1${path}`).set(as(user)).send(body);
    const get = (user, path) => api().get(`/api/v1${path}`).set(as(user));

    // --- 1. Sign-up: a 30-day Growth trial -------------------------------------------------------
    const owner = await login('saas-owner@example.com', { name: 'Asha' });
    const orgId = owner.data.organizationId;
    await api().patch('/api/v1/organization').set(as(owner)).send({ name: 'Saffron Traders', gstin: '08AAACS1234C1Z5' });
    expect((await get(owner, '/billing/subscription')).body.data).toMatchObject({ plan: { key: 'growth' }, subscription: { status: 'trialing', daysLeft: 30 } });

    // --- 2. The trial ends; adding waits for a plan; Pro is paid on the test gateway --------------
    await Organization.updateOne({ _id: orgId }, { $set: { 'subscription.trialEndsAt': new Date(Date.now() - 1000) } });
    expect((await post(owner, '/contacts', { name: 'Blocked' })).body.code).toBe('SUBSCRIPTION_INACTIVE');
    const { checkoutUrl } = (await post(owner, '/billing/checkout', { plan: 'pro' })).body.data;
    expect((await api().post(new URL(checkoutUrl).pathname).type('form').send({ action: 'pay' })).status).toBe(200);
    await until(async () => (await Organization.findById(orgId)).plan === 'pro', 'the Pro plan');
    const invoice = await until(() => BillingInvoice.findOne({ organizationId: orgId }), 'the GST invoice');
    // No platform GSTIN in this test, so the seller's state is unknown: IGST.
    expect(invoice.toObject()).toMatchObject({ totalPaise: 353882, taxablePaise: 299900, igstPaise: 53982, buyer: { gstin: '08AAACS1234C1Z5' } });

    // --- 3. The API needs Growth: upgrade (at once) ----------------------------------------------------
    expect((await post(owner, '/api-keys', { name: 'ERP', scopes: ['leads:write', 'contacts:read'] })).body.code).toBe('PLAN_LIMIT');
    expect((await post(owner, '/billing/checkout', { plan: 'growth' })).body.data).toMatchObject({ changed: true, when: 'now' });

    // --- 4. The ERP: an API key and a signed webhook for new leads -----------------------------------
    const agent = await inviteAndJoin(owner.token, 'saas-agent@example.com', { role: 'agent', displayName: 'Arun', modules: ['inbox', 'leads'] });
    await post(owner, '/whatsapp/accounts', { provider: 'mock' });
    await post(owner, '/products', { name: 'Jeera 25kg', pricePaise: 300000, gstRatePct: 5 });
    const key = (await post(owner, '/api-keys', { name: 'ERP', scopes: ['leads:write', 'contacts:read'] })).body.data.key;
    const hook = (await post(owner, '/outbound-webhooks', { url: 'https://erp.example.com/crm-events', events: ['lead.created'] })).body.data;
    expect(hook.secret).toMatch(/^whsec_/);

    // --- 5. The agent's phone gets notifications ---------------------------------------------------------
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    expect((await post(agent, '/push/subscriptions', { endpoint: 'https://push.example.com/send/arun-phone', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } })).status).toBe(201);

    // --- 6. The ERP sends a lead; the CRM tells the ERP back, signed ----------------------------------
    const sent = await api().post('/api/public/v1/leads').set('Authorization', `Bearer ${key}`)
      .send({ contact: { name: 'Ravi Traders', phone: '9829011111' }, product: 'Jeera 25kg', quantity: 10, externalId: 'erp-501' });
    expect(sent.status).toBe(201);
    const leadId = sent.body.data.lead.id;
    const call = await until(() => erpCalls.find((c) => JSON.parse(c.body).type === 'lead.created'), 'the webhook');
    expect(JSON.parse(call.body)).toMatchObject({ data: { lead: { id: leadId, source: 'API', contact: { phone: '+919829011111' } } } });
    expect(call.headers['X-CRM-Signature']).toBe(`sha256=${crypto.createHmac('sha256', hook.secret).update(call.body).digest('hex')}`);

    // --- 7. The customer writes on WhatsApp; the agent asks the AI for a reply ---------------------------
    const lead = await Lead.findById(leadId);
    await Lead.updateOne({ _id: leadId }, { $set: { ownerId: agent.data.member.id } });
    await api().put('/api/v1/ai/settings').set(as(owner)).send({ enabled: true });
    const chat = (await post(owner, '/dev/simulate/whatsapp-inbound', { from: '9829011111', name: 'Ravi Traders', text: 'Jeera ka rate?' })).body.data;
    await api().patch(`/api/v1/conversations/${chat.conversationId}`).set(as(owner)).send({ assigneeId: agent.data.member.id });
    const suggestion = await post(agent, `/conversations/${chat.conversationId}/ai/suggest`, {});
    expect(suggestion.body.data.suggestions[0]).toContain('₹3,000');
    expect((await post(agent, `/conversations/${chat.conversationId}/messages`, { text: suggestion.body.data.suggestions[0] })).status).toBe(201);
    expect(lead.contactId).toBeTruthy();

    // A bell note for the agent also reaches their phone.
    await require('../services/notificationService').notify(orgId, [agent.data.member.id], { title: 'Ravi Traders is waiting', link: `Inbox.html?c=${chat.conversationId}` });
    await until(() => pushCalls.length > 0, 'the push notification');
    expect(pushCalls[0].headers['Content-Encoding']).toBe('aes128gcm');

    // --- 8. All the company's data in one file, without secrets ---------------------------------------
    const backup = await get(owner, '/exports/crm');
    expect(backup.status).toBe(200);
    expect(backup.body).toMatchObject({ version: 2 });
    expect(backup.body.leads.map((l) => l.sourceRef)).toContain('erp-501');
    expect(backup.body.planInvoices).toHaveLength(1);
    const text = JSON.stringify(backup.body);
    expect(text).not.toContain(hook.secret);
    expect(text).not.toContain(key.split('_')[2]);
    expect((await get(owner, '/audit-logs?action=apikey')).body.data.map((e) => e.action)).toEqual(['apikey.created']);

    // --- 9. The company leaves: 7 days, then everything goes (the invoice stays) ------------------------
    await api().delete('/api/v1/organization').set(as(owner)).send({ confirmName: 'Saffron Traders' });
    expect(await Notification.exists({ organizationId: orgId, title: /will be deleted/ })).toBeTruthy();
    await Organization.updateOne({ _id: orgId }, { $set: { 'deletion.scheduledFor': new Date(Date.now() - 1000) } });
    await deletion.purgeDue();
    expect(await Organization.exists({ _id: orgId })).toBeNull();
    expect(await Lead.exists({ _id: leadId })).toBeNull();
    expect(await BillingInvoice.countDocuments({ organizationId: orgId })).toBe(1);
    expect((await api().get('/api/public/v1/me').set('Authorization', `Bearer ${key}`)).status).toBe(401);
  }, 120000);
});
