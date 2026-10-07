jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const Organization = require('../models/Organization');
const BillingInvoice = require('../models/BillingInvoice');
const BillingPlan = require('../models/BillingPlan');
const Notification = require('../models/Notification');
const Workflow = require('../models/Workflow');
const InboundEvent = require('../models/InboundEvent');
const queue = require('../jobs/queue');
const env = require('../config/env');
const billing = require('../services/billingService');
const mock = require('../integrations/billing/mock');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const DAY = 24 * 60 * 60 * 1000;
const settle = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    await queue.runDue();
  }
};
const orgOf = (user) => Organization.findById(user.data.organizationId);
const testPage = (url) => new URL(url).pathname;
const press = async (url, action) => {
  const res = await api().post(testPage(url)).type('form').send({ action });
  expect(res.status).toBe(200);
  await settle();
};
const notes = async (organizationId) => (await Notification.find({ organizationId }).sort({ createdAt: 1 })).map((n) => n.title);

describe('Paying for the plan (Phase 10B)', () => {
  beforeAll(() => {
    queue.define(billing.JOBS.WEBHOOK, billing.processWebhook, { maxAttempts: 6 });
    env.billing.seller.name = 'Yellow Software Pvt Ltd';
    env.billing.seller.gstin = '08AAACY9999C1Z1';
    env.billing.seller.address = 'Jaipur, Rajasthan';
  });

  it('a trial company chooses Pro: the rest of the trial stays free, then each month gets a GST invoice', async () => {
    const owner = await login('bill-owner@example.com', { name: 'Asha' });
    const agent = await inviteAndJoin(owner.token, 'bill-agent@example.com', { role: 'agent' });
    await api().patch('/api/v1/organization').set(bearer(owner.token)).send({ name: 'Yellow Traders', gstin: '08AAACY1234C1Z5', address: 'MI Road', city: 'Jaipur' });
    expect((await api().post('/api/v1/billing/checkout').set(bearer(agent.token)).send({ plan: 'pro' })).status).toBe(403);
    expect((await api().get('/api/v1/billing/subscription').set(bearer(owner.token))).body.data.billing).toMatchObject({ enabled: true, provider: 'mock', test: true });

    const checkout = await api().post('/api/v1/billing/checkout').set(bearer(owner.token)).send({ plan: 'pro' });
    expect(checkout.status).toBe(200);
    const { checkoutUrl, startsAt } = checkout.body.data;
    expect(checkoutUrl).toMatch(/\/api\/v1\/webhooks\/billing-test\/mock_sub_/);
    expect(new Date(startsAt).getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    let state = (await api().get('/api/v1/billing/subscription').set(bearer(owner.token))).body.data;
    expect(state.subscription).toMatchObject({ status: 'trialing', pendingPlan: 'pro', checkoutUrl });
    expect((await api().get(testPage(checkoutUrl))).text).toContain('Pro plan');

    // Authorised now; the first charge waits for the trial's end.
    await press(checkoutUrl, 'pay');
    state = (await api().get('/api/v1/billing/subscription').set(bearer(owner.token))).body.data;
    expect(state.plan.key).toBe('pro');
    expect(state.subscription).toMatchObject({ status: 'active', locked: false, pendingPlan: null, checkoutUrl: null });
    expect(new Date(state.subscription.firstChargeAt).getTime()).toBe(new Date(startsAt).getTime());
    expect(await BillingInvoice.countDocuments()).toBe(0);

    // The month is charged: a GST invoice (same state: CGST + SGST), numbered, as a PDF.
    await press(checkoutUrl, 'charge');
    const invoices = (await api().get('/api/v1/billing/invoices').set(bearer(owner.token))).body.data;
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ number: 'YC/2026-27/0001', planName: 'Pro', totalPaise: 353882, taxablePaise: 299900, gstPaise: 53982 });
    const stored = await BillingInvoice.findById(invoices[0].id);
    expect(stored).toMatchObject({ cgstPaise: 26991, sgstPaise: 26991, igstPaise: 0, placeOfSupplyCode: '08', sac: '998315' });
    expect(stored.buyer).toMatchObject({ name: 'Yellow Traders', gstin: '08AAACY1234C1Z5', stateCode: '08' });
    expect(stored.seller).toMatchObject({ name: 'Yellow Software Pvt Ltd', stateCode: '08' });
    const pdf = await api().get(`/api/v1/billing/invoices/${invoices[0].id}/pdf`).set(bearer(owner.token)).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    expect((await api().get('/api/v1/billing/invoices').set(bearer(agent.token))).status).toBe(403);
    const org = await orgOf(owner);
    expect(await notes(org._id)).toEqual(expect.arrayContaining(['Your Pro plan is active', 'Payment received: ₹3,538.82']));
    // The same payment reported again (webhook + check) makes no second invoice.
    await billing.syncOrganization(org._id);
    expect(await BillingInvoice.countDocuments({ organizationId: org._id })).toBe(1);
  }, 60000);

  it('upgrades at once, downgrades next month (pausing workflows), and locks after failed payments', async () => {
    const owner = await login('bill-change@example.com', { name: 'Bina' });
    const org = await orgOf(owner);
    await Organization.updateOne({ _id: org._id }, { $set: { 'subscription.trialEndsAt': new Date(Date.now() + 2 * 60 * 60 * 1000) } });
    const { checkoutUrl, startsAt } = (await api().post('/api/v1/billing/checkout').set(bearer(owner.token)).send({ plan: 'pro' })).body.data;
    expect(startsAt).toBeNull(); // less than a day of trial left: charged now
    await press(checkoutUrl, 'pay');
    expect((await BillingInvoice.find({ organizationId: org._id })).map((i) => i.planName)).toEqual(['Pro']);

    const up = await api().post('/api/v1/billing/checkout').set(bearer(owner.token)).send({ plan: 'growth' });
    expect(up.body.data).toMatchObject({ changed: true, when: 'now' });
    expect((await Organization.findById(org._id)).plan).toBe('growth');
    expect((await api().post('/api/v1/billing/checkout').set(bearer(owner.token)).send({ plan: 'growth' })).body.code).toBe('SAME_PLAN');
    const workflow = (await api().post('/api/v1/workflows').set(bearer(owner.token)).send({ name: 'Flow', trigger: { type: 'lead.created' }, steps: [{ type: 'tag.add', params: { tag: 'new' } }] })).body.data;

    const down = await api().post('/api/v1/billing/checkout').set(bearer(owner.token)).send({ plan: 'starter' });
    expect(down.body.data).toMatchObject({ changed: true, when: 'cycle_end' });
    expect((await Organization.findById(org._id)).toObject()).toMatchObject({ plan: 'growth', subscription: { pendingPlan: 'starter' } });
    await press(checkoutUrl, 'charge');
    expect((await Organization.findById(org._id)).plan).toBe('starter');
    expect((await Workflow.findById(workflow.id)).status).toBe('Paused');
    expect(await notes(org._id)).toContain('1 workflow was paused');

    // A failed charge: payment due (still works); all retries failed: halted (locked).
    await press(checkoutUrl, 'fail');
    let state = (await api().get('/api/v1/billing/subscription').set(bearer(owner.token))).body.data.subscription;
    expect(state).toMatchObject({ status: 'past_due', locked: false });
    await press(checkoutUrl, 'fail');
    state = (await api().get('/api/v1/billing/subscription').set(bearer(owner.token))).body.data.subscription;
    expect(state).toMatchObject({ status: 'halted', locked: true });
    expect((await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'New' })).body).toMatchObject({ code: 'SUBSCRIPTION_INACTIVE', message: expect.stringContaining('Your subscription payment did not go through') });
    // Paying again (Razorpay retries when the card works) brings it back.
    await press(checkoutUrl, 'charge');
    expect((await api().get('/api/v1/billing/subscription').set(bearer(owner.token))).body.data.subscription).toMatchObject({ status: 'active', locked: false });
  }, 60000);

  it('cancels at the end of the paid month, then the plan ends', async () => {
    const owner = await login('bill-cancel@example.com', { name: 'Chetan' });
    const org = await orgOf(owner);
    await Organization.updateOne({ _id: org._id }, { $set: { 'subscription.trialEndsAt': new Date(Date.now() - DAY) } });
    expect((await api().post('/api/v1/billing/subscription/cancel').set(bearer(owner.token))).body.code).toBe('NOT_SUBSCRIBED');
    const { checkoutUrl } = (await api().post('/api/v1/billing/checkout').set(bearer(owner.token)).send({ plan: 'starter' })).body.data;
    await press(checkoutUrl, 'pay');
    const cancelled = await api().post('/api/v1/billing/subscription/cancel').set(bearer(owner.token));
    expect(cancelled.body.data.subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    await press(checkoutUrl, 'charge'); // the month ends: Razorpay cancels instead of charging
    const after = await Organization.findById(org._id);
    expect(after.subscription.status).toBe('cancelled');
    expect((await api().get('/api/v1/billing/subscription').set(bearer(owner.token))).body.data.subscription).toMatchObject({ status: 'cancelled', locked: false });
    await Organization.updateOne({ _id: org._id }, { $set: { 'subscription.currentPeriodEnd': new Date(Date.now() - 1000) } });
    expect((await api().get('/api/v1/billing/subscription').set(bearer(owner.token))).body.data.subscription).toMatchObject({ status: 'expired', locked: true, wasTrial: false });
    expect(await BillingInvoice.countDocuments({ organizationId: org._id })).toBe(1);
  }, 60000);

  it('finds a payment whose webhook never came ("Check now")', async () => {
    const owner = await login('bill-sync@example.com', { name: 'Divya' });
    const org = await orgOf(owner);
    await Organization.updateOne({ _id: org._id }, { $set: { 'subscription.trialEndsAt': new Date(Date.now() - DAY) } });
    const { checkoutUrl } = (await api().post('/api/v1/billing/checkout').set(bearer(owner.token)).send({ plan: 'scale' })).body.data;
    mock.act(checkoutUrl.split('/').pop(), 'pay'); // paid, but nothing reached the CRM
    expect((await Organization.findById(org._id)).subscription.status).toBe('trialing');
    const checked = await api().post('/api/v1/billing/subscription/refresh').set(bearer(owner.token));
    expect(checked.body.data).toMatchObject({ plan: { key: 'scale' }, subscription: { status: 'active' } });
    expect(await BillingInvoice.countDocuments({ organizationId: org._id })).toBe(1);
  }, 60000);

  it('takes signed Razorpay webhooks once, and invoices across states with IGST', async () => {
    const owner = await login('bill-rzp@example.com', { name: 'Esha' });
    await api().patch('/api/v1/organization').set(bearer(owner.token)).send({ name: 'Mumbai Mart', gstin: '27AAACM1234C1Z1' });
    const org = await orgOf(owner);
    const saved = { provider: env.billing.provider, ...env.billing.razorpay };
    Object.assign(env.billing, { provider: 'razorpay' });
    Object.assign(env.billing.razorpay, { keyId: 'rzp_test_platform', keySecret: 'platform-secret', webhookSecret: 'platform-webhook-secret' });
    await BillingPlan.create({ provider: 'razorpay', keyId: 'rzp_test_platform', planKey: 'growth', amountPaise: 707882, providerPlanId: 'plan_growth1' });
    await Organization.updateOne({ _id: org._id }, { $set: { 'subscription.provider': 'razorpay', 'subscription.providerSubscriptionId': 'sub_rzp1', 'subscription.gatewayStatus': 'created', 'subscription.pendingPlan': 'growth' } });
    const now = Math.floor(Date.now() / 1000);
    const entity = { id: 'sub_rzp1', entity: 'subscription', plan_id: 'plan_growth1', status: 'active', current_start: now, current_end: now + 30 * 86400, notes: { organizationId: String(org._id) } };
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      expect(String(url)).toBe('https://api.razorpay.com/v1/subscriptions/sub_rzp1');
      return new Response(JSON.stringify(entity), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const raw = JSON.stringify({
        entity: 'event', event: 'subscription.charged',
        payload: { subscription: { entity }, payment: { entity: { id: 'pay_rzp1', amount: 707882, status: 'captured', method: 'upi', created_at: now } } },
      });
      const sign = (body, secret = 'platform-webhook-secret') => crypto.createHmac('sha256', secret).update(body).digest('hex');
      const post = (body, signature, eventId = 'evt_1') => api().post('/api/v1/webhooks/billing/razorpay').set('Content-Type', 'application/json')
        .set('X-Razorpay-Signature', signature).set('X-Razorpay-Event-Id', eventId).send(body);
      expect((await post(raw, sign(raw, 'wrong'))).status).toBe(401);
      expect((await post(raw, sign(raw))).status).toBe(200);
      expect((await post(raw, sign(raw))).status).toBe(200); // Razorpay retries
      await settle();
      expect(await InboundEvent.countDocuments({ provider: 'razorpay-billing' })).toBe(1);
      const after = await Organization.findById(org._id);
      expect(after.toObject()).toMatchObject({ plan: 'growth', subscription: { status: 'active', gatewayStatus: 'active' } });
      const invoice = await BillingInvoice.findOne({ organizationId: org._id });
      expect(invoice).toMatchObject({ planName: 'Growth', totalPaise: 707882, taxablePaise: 599900, igstPaise: 107982, cgstPaise: 0, placeOfSupplyCode: '27', providerPaymentId: 'pay_rzp1' });
      expect(invoice.number).toMatch(/^YC\/2026-27\/\d{4}$/);
    } finally {
      fetchSpy.mockRestore();
      Object.assign(env.billing, { provider: saved.provider });
      Object.assign(env.billing.razorpay, { keyId: saved.keyId, keySecret: saved.keySecret, webhookSecret: saved.webhookSecret });
    }
  }, 60000);

  it('reminds owners before the trial ends, once each time', async () => {
    const owner = await login('bill-remind@example.com', { name: 'Farhan' });
    const org = await orgOf(owner);
    await Organization.updateOne({ _id: org._id }, { $set: { 'subscription.trialEndsAt': new Date(Date.now() + 2.5 * DAY) } });
    await billing.remindTrials();
    await billing.remindTrials();
    expect(await notes(org._id)).toEqual(['Your free trial ends in 3 days']);
    await Organization.updateOne({ _id: org._id }, { $set: { 'subscription.trialEndsAt': new Date(Date.now() - 1000) } });
    await billing.remindTrials();
    expect(await notes(org._id)).toEqual(['Your free trial ends in 3 days', 'Your free trial has ended']);
  });

  it('says how to change the plan when paying online is off', async () => {
    const owner = await login('bill-off@example.com', { name: 'Gita' });
    const saved = env.billing.provider;
    env.billing.provider = 'off';
    env.billing.seller.email = 'billing@yellowcrm.example';
    try {
      const refused = await api().post('/api/v1/billing/checkout').set(bearer(owner.token)).send({ plan: 'pro' });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'BILLING_OFF', message: 'Paying for a plan online is not switched on yet. Write to billing@yellowcrm.example to change your plan.' });
      expect((await api().get('/api/v1/billing/subscription').set(bearer(owner.token))).body.data.billing).toMatchObject({ enabled: false });
    } finally {
      env.billing.provider = saved;
    }
  });
});
