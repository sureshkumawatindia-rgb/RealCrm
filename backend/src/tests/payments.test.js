jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const InboundEvent = require('../models/InboundEvent');
const Lead = require('../models/Lead');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const Order = require('../models/Order');
const Organization = require('../models/Organization');
const PaymentConnection = require('../models/PaymentConnection');
const PaymentLink = require('../models/PaymentLink');
const Quotation = require('../models/Quotation');
const queue = require('../jobs/queue');
const paymentLinks = require('../services/paymentLinkService');
const engine = require('../services/automation/engine');
const razorpay = require('../integrations/payments/razorpay');
const cashfree = require('../integrations/payments/cashfree');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 8A: payment gateways (Razorpay and Cashfree faked at fetch, plus the test gateway), payment
// links for orders, quotations and amounts, signed webhooks and the 10-minute status check, what a
// payment does (order, quotation, lead, receipt, bell), payments entered by hand, and who sees what.
const RZP = { keyId: 'rzp_test_KEY123456', keySecret: 'rzp-secret-0001', webhookSecret: 'rzp-hook-secret-01' };
const CF = { keyId: 'CF-APP-778899', keySecret: 'cf-secret-key-0002' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const settle = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await queue.runDue();
  }
};

// The gateways as the fake fetch keeps them.
const gateway = { calls: [], razorpay: new Map(), cashfree: new Map() };
let plinks = 0;

beforeAll(() => {
  paymentLinks.register(queue);
  jest.spyOn(global, 'fetch').mockImplementation(async (target, options = {}) => {
    const url = String(target);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    gateway.calls.push({ url, method, headers: options.headers || {}, body });
    if (url.startsWith('https://api.razorpay.com/v1/')) {
      if (options.headers.Authorization !== `Basic ${Buffer.from(`${RZP.keyId}:${RZP.keySecret}`).toString('base64')}`) {
        return json({ error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } }, 401);
      }
      if (url.endsWith('/payment_links?count=1')) return json({ count: 0, payment_links: [] });
      if (url.endsWith('/payment_links') && method === 'POST') {
        plinks += 1;
        const link = { id: `plink_Test${plinks}`, short_url: `https://rzp.io/i/T${plinks}`, status: 'created', amount: body.amount, amount_paid: 0, expire_by: body.expire_by, reference_id: body.reference_id, payments: null };
        gateway.razorpay.set(link.id, link);
        return json(link);
      }
      const cancel = /\/payment_links\/(plink_\w+)\/cancel$/.exec(url);
      if (cancel && method === 'POST') {
        const link = gateway.razorpay.get(cancel[1]);
        if (link.status !== 'created') return json({ error: { code: 'BAD_REQUEST_ERROR', description: 'Payment Link cannot be cancelled' } }, 400);
        link.status = 'cancelled';
        return json(link);
      }
      const one = /\/payment_links\/(plink_\w+)$/.exec(url);
      if (one) return json(gateway.razorpay.get(one[1]));
    }
    if (url.startsWith('https://sandbox.cashfree.com/pg/')) {
      if (options.headers['x-client-id'] !== CF.keyId || options.headers['x-client-secret'] !== CF.keySecret || !options.headers['x-api-version']) {
        return json({ message: 'authentication Failed', code: 'request_failed', type: 'authentication_error' }, 401);
      }
      if (url.endsWith('/links/ycrm-key-check')) return json({ message: 'link does not exist', code: 'link_not_found', type: 'invalid_request_error' }, 404);
      if (url.endsWith('/links') && method === 'POST') {
        const link = { cf_link_id: 1001, link_id: body.link_id, link_url: `https://payments-test.cashfree.com/links/${body.link_id}`, link_status: 'ACTIVE', link_amount: body.link_amount, link_amount_paid: 0, link_expiry_time: body.link_expiry_time, orders: [] };
        gateway.cashfree.set(link.link_id, link);
        return json(link);
      }
      const orders = /\/links\/([\w-]+)\/orders\?status=PAID$/.exec(url);
      if (orders) return json(gateway.cashfree.get(orders[1]).orders);
      const one = /\/links\/([\w-]+)$/.exec(url);
      if (one) return json(gateway.cashfree.get(one[1]));
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  });
});
afterAll(async () => {
  await queue.stop();
  jest.restoreAllMocks();
});

describe('Gateway clients', () => {
  it('check Razorpay and Cashfree webhook signatures and read their events', () => {
    const raw = Buffer.from(JSON.stringify({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: 'plink_A1', amount: 118000, amount_paid: 118000, status: 'paid', reference_id: 'ycrm_x' } },
        payment: { entity: { id: 'pay_A1', amount: 118000, method: 'upi', status: 'captured', created_at: 1791000000 } },
      },
    }));
    const hex = crypto.createHmac('sha256', 'hook-secret').update(raw).digest('hex');
    expect(razorpay.verifyWebhook({ rawBody: raw, headers: { 'x-razorpay-signature': hex }, secrets: { webhookSecret: 'hook-secret' } })).toBe(true);
    expect(razorpay.verifyWebhook({ rawBody: raw, headers: { 'x-razorpay-signature': hex }, secrets: { webhookSecret: 'other' } })).toBe(false);
    expect(razorpay.verifyWebhook({ rawBody: Buffer.concat([raw, Buffer.from(' ')]), headers: { 'x-razorpay-signature': hex }, secrets: { webhookSecret: 'hook-secret' } })).toBe(false);
    expect(razorpay.parseWebhook(JSON.parse(raw), { 'x-razorpay-event-id': 'evt_1' })).toEqual({
      eventId: 'evt_1', providerLinkId: 'plink_A1', status: 'paid', amountPaidPaise: 118000,
      payment: { providerPaymentId: 'pay_A1', amountPaise: 118000, method: 'upi', paidAt: new Date(1791000000 * 1000) },
    });
    expect(razorpay.parseWebhook({ event: 'payment.captured', payload: {} })).toBeNull();
    expect(razorpay.modeOf('rzp_live_abc')).toBe('live');

    const cfRaw = Buffer.from(JSON.stringify({
      data: { cf_link_id: 9, link_id: 'ycrm_y', link_status: 'PARTIALLY_PAID', link_amount_paid: '55.50', order: { order_id: 'CFPay_1', order_amount: '55.50', transaction_id: 77, transaction_status: 'SUCCESS' } },
      type: 'PAYMENT_LINK_EVENT', event_time: '2026-10-05T12:55:06+05:30',
    }));
    const ts = '1791000000';
    const b64 = crypto.createHmac('sha256', 'cf-secret').update(ts + cfRaw.toString()).digest('base64');
    expect(cashfree.verifyWebhook({ rawBody: cfRaw, headers: { 'x-webhook-signature': b64, 'x-webhook-timestamp': ts }, secrets: { keySecret: 'cf-secret' } })).toBe(true);
    expect(cashfree.verifyWebhook({ rawBody: cfRaw, headers: { 'x-webhook-signature': b64, 'x-webhook-timestamp': '1791000001' }, secrets: { keySecret: 'cf-secret' } })).toBe(false);
    expect(cashfree.parseWebhook(JSON.parse(cfRaw))).toMatchObject({
      providerLinkId: 'ycrm_y', status: 'partially_paid', amountPaidPaise: 5550, payment: { providerPaymentId: 'CFPay_1', amountPaise: 5550 },
    });
    expect(cashfree.istIso(new Date('2026-10-12T13:00:00Z'))).toBe('2026-10-12T18:30:00+05:30');
  });
});

describe('Payment links', () => {
  let owner;
  let agent;
  let stranger;
  let product;
  let razorpayConn;
  let cashfreeConn;
  let orderA;
  let linkA;
  let quotationB;
  let linkB;
  const as = (user) => bearer(user.token);
  const post = (user, path, body) => api().post(`/api/v1${path}`).set(as(user)).send(body);
  const get = (user, path) => api().get(`/api/v1${path}`).set(as(user));
  const chatWith = async (from, name, text = 'Rate please') => (await post(owner, '/dev/simulate/whatsapp-inbound', { from, name, text })).body.data;
  // A quotation for 10 × ₹1,000 + 18% GST (same state) = ₹11,800.00 from a customer's chat.
  const quoteFor = async (conversationId) => (await post(owner, '/quotations', { conversationId, items: [{ productId: product.id, quantity: 10 }] })).body.data;
  const orderFor = async (conversationId) => {
    const quotation = await quoteFor(conversationId);
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(as(owner)).send({ status: 'Accepted' });
    return (await post(owner, '/orders', { quotationId: quotation.id })).body.data;
  };
  const razorpayHook = (connection, payload, eventId) => {
    const raw = JSON.stringify(payload);
    return api().post(connection.webhookPath).set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', crypto.createHmac('sha256', RZP.webhookSecret).update(raw).digest('hex')).set('X-Razorpay-Event-Id', eventId).send(raw);
  };
  const cashfreeHook = (connection, payload) => {
    const raw = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    return api().post(connection.webhookPath).set('Content-Type', 'application/json')
      .set('x-webhook-timestamp', ts).set('x-webhook-signature', crypto.createHmac('sha256', CF.keySecret).update(ts + raw).digest('base64')).send(raw);
  };

  beforeAll(async () => {
    owner = await login('pay-owner@example.com', { name: 'Asha' });
    agent = await inviteAndJoin(owner.token, 'pay-agent@example.com', { role: 'agent', modules: ['leads', 'deals', 'inbox'] });
    stranger = await login('pay-stranger@example.com');
    await api().patch('/api/v1/organization').set(as(owner)).send({ name: 'Yellow Traders', gstin: '08AAACY1234C1Z5', city: 'Jaipur' });
    await post(owner, '/whatsapp/accounts', { provider: 'mock' });
    await post(owner, '/templates/sync', {});
    product = (await post(owner, '/products', { name: 'Cumin 25kg', unit: 'bag', hsnSac: '0909', pricePaise: 100000, gstRatePct: 18 })).body.data;
  });

  it('connects Razorpay and Cashfree with the organization\'s own keys, never showing the secrets again', async () => {
    const wrong = await post(owner, '/payments/connections', { provider: 'razorpay', ...RZP, keySecret: 'not-the-secret' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('PAYMENT_KEYS_REFUSED');
    expect(await PaymentConnection.countDocuments({})).toBe(0);

    const created = await post(owner, '/payments/connections', { provider: 'razorpay', ...RZP });
    expect(created.status).toBe(201);
    razorpayConn = created.body.data;
    expect(razorpayConn).toMatchObject({ provider: 'razorpay', mode: 'test', status: 'connected', isDefault: true, keyId: RZP.keyId, keySecret: { configured: true, last4: '0001' }, webhookSecretConfigured: true });
    expect(razorpayConn.webhookUrl).toMatch(/\/api\/v1\/webhooks\/payments\/razorpay\/[a-f0-9]{32}$/);
    expect(JSON.stringify(created.body)).not.toContain(RZP.keySecret);
    expect(JSON.stringify(created.body)).not.toContain(RZP.webhookSecret);
    const stored = await PaymentConnection.findById(razorpayConn.id);
    expect(stored.keySecretEnc).not.toContain(RZP.keySecret);

    expect((await post(owner, '/payments/connections', { provider: 'razorpay', ...RZP })).body.code).toBe('GATEWAY_EXISTS');
    expect((await post(owner, '/payments/connections', { provider: 'razorpay', keyId: RZP.keyId, keySecret: RZP.keySecret })).status).toBe(400); // Razorpay needs its webhook secret
    cashfreeConn = (await post(owner, '/payments/connections', { provider: 'cashfree', ...CF })).body.data;
    expect(cashfreeConn).toMatchObject({ provider: 'cashfree', mode: 'test', status: 'connected', isDefault: false });
    expect(gateway.calls.at(-1)).toMatchObject({ url: 'https://sandbox.cashfree.com/pg/links/ycrm-key-check' });

    expect((await get(owner, '/payments/connections')).body.data.map((c) => c.provider)).toEqual(['razorpay', 'cashfree']);
    expect((await get(agent, '/payments/connections')).status).toBe(403);
    expect((await post(agent, '/payments/connections', { provider: 'mock' })).status).toBe(403);
    expect((await get(stranger, '/payments/connections')).body.data).toEqual([]);
  });

  it('makes a Razorpay link for an order; the signed webhook pays the order, wins the lead and sends a receipt', async () => {
    const chat = await chatWith('98290 70001', 'Ravi Traders');
    orderA = await orderFor(chat.conversationId);
    expect(orderA).toMatchObject({ totals: { grandTotalPaise: 1180000 }, paymentStatus: 'unpaid', duePaise: 1180000, amountPaidPaise: 0 });

    const made = await api().post('/api/v1/payment-links').set(as(owner)).set('Idempotency-Key', 'pay-link-0001').send({ orderId: orderA.id });
    expect(made.status).toBe(201);
    linkA = made.body.data;
    expect(linkA).toMatchObject({ provider: 'razorpay', purpose: 'order', status: 'created', amountPaise: 1180000, documentNumber: orderA.number, shortUrl: expect.stringMatching(/^https:\/\/rzp\.io\/i\//), customerName: 'Ravi Traders' });
    const sentToRazorpay = gateway.calls.find((c) => c.method === 'POST' && c.url.endsWith('/payment_links')).body;
    expect(sentToRazorpay).toMatchObject({
      amount: 1180000, currency: 'INR', accept_partial: false, reference_id: linkA.referenceId, description: `Order ${orderA.number}`,
      customer: { name: 'Ravi Traders', contact: '+919829070001' }, notify: { sms: false, email: false }, reminder_enable: false,
    });
    expect(linkA.referenceId).toMatch(/^ycrm_[a-f0-9]{24}$/);
    expect(sentToRazorpay.expire_by - Math.floor(Date.now() / 1000)).toBeGreaterThan(6.9 * 86400); // 7 days by default
    const again = await post(owner, '/payment-links', { orderId: orderA.id });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('OPEN_LINK_EXISTS');
    expect((await post(owner, '/payment-links', { orderId: orderA.id, quotationId: orderA.quotationId })).status).toBe(400);

    // The customer pays: Razorpay calls the connection's address.
    const paid = {
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: linkA.providerLinkId, amount: 1180000, amount_paid: 1180000, status: 'paid', reference_id: linkA.referenceId } },
        payment: { entity: { id: 'pay_RaviFull01', amount: 1180000, method: 'upi', status: 'captured', created_at: Math.floor(Date.now() / 1000) } },
      },
    };
    gateway.razorpay.get(linkA.providerLinkId).status = 'paid';
    const raw = JSON.stringify(paid);
    expect((await api().post(razorpayConn.webhookPath).set('Content-Type', 'application/json').set('X-Razorpay-Signature', 'f'.repeat(64)).send(raw)).status).toBe(401);
    expect((await api().post(razorpayConn.webhookPath.replace(/[a-f0-9]{32}$/, 'a'.repeat(32))).set('Content-Type', 'application/json').send(raw)).status).toBe(404);
    expect((await razorpayHook(razorpayConn, paid, 'evt_ravi_1')).status).toBe(200);
    await settle();

    const order = (await get(owner, `/orders/${orderA.id}`)).body.data;
    expect(order).toMatchObject({ paymentStatus: 'paid', amountPaidPaise: 1180000, duePaise: 0, stage: 'Received' });
    expect(order.payments).toEqual([expect.objectContaining({ source: 'link', provider: 'razorpay', providerPaymentId: 'pay_RaviFull01', amountPaise: 1180000, method: 'upi' })]);
    expect((await get(owner, `/payment-links/${linkA.id}`)).body.data).toMatchObject({ status: 'paid', amountPaidPaise: 1180000, payments: [{ providerPaymentId: 'pay_RaviFull01' }], receipts: [{ status: 'sent' }] });
    expect((await Lead.findById(order.leadId)).stage).toBe('Won');
    expect((await Contact.findById(order.contactId)).lifecycle).toBe('customer');
    const receipt = await Message.findOne({ conversationId: chat.conversationId, 'automation.kind': 'receipt' });
    expect(receipt.text).toContain('we have received your payment of ₹11,800.00 for order');
    expect(receipt.text).toContain('pay_RaviFull01');
    expect(receipt.text).not.toContain('Balance due');
    expect(await Notification.findOne({ title: 'Payment received: ₹11,800.00' })).toBeTruthy();

    // Razorpay retries, and the status check finds the same payment: still counted once.
    expect((await razorpayHook(razorpayConn, paid, 'evt_ravi_1')).status).toBe(200);
    expect((await razorpayHook(razorpayConn, paid, 'evt_ravi_2')).status).toBe(200);
    await settle();
    gateway.razorpay.get(linkA.providerLinkId).payments = [{ payment_id: 'pay_RaviFull01', amount: 1180000, method: 'upi', status: 'captured', created_at: Math.floor(Date.now() / 1000) }];
    gateway.razorpay.get(linkA.providerLinkId).amount_paid = 1180000;
    await post(owner, `/payment-links/${linkA.id}/refresh`, {});
    expect((await Order.findById(orderA.id)).payments).toHaveLength(1);
    expect(await Message.countDocuments({ conversationId: chat.conversationId, 'automation.kind': 'receipt' })).toBe(1);
    expect((await post(owner, '/payment-links', { orderId: orderA.id })).body.code).toBe('NOTHING_DUE');
  });

  it('a Cashfree link for a quotation: a part payment accepts it and makes the order; the status check finds the rest', async () => {
    const chat = await chatWith('98290 70002', 'Kiran Stores');
    // The customer's 24-hour window has closed and there is no receipt template yet.
    await Conversation.updateOne({ _id: chat.conversationId }, { lastInboundAt: new Date(Date.now() - 2 * 86400000) });
    quotationB = await quoteFor(chat.conversationId);
    const made = await post(owner, '/payment-links', { quotationId: quotationB.id, acceptPartial: true, minPartialPaise: 100000, connectionId: cashfreeConn.id, expiresInDays: 3 });
    expect(made.status).toBe(201);
    linkB = made.body.data;
    expect(linkB).toMatchObject({ provider: 'cashfree', purpose: 'quotation', amountPaise: 1180000, acceptPartial: true, minPartialPaise: 100000, shortUrl: expect.stringContaining('cashfree.com/links/ycrm_') });
    expect(gateway.calls.find((c) => c.method === 'POST' && c.url.endsWith('/pg/links')).body).toMatchObject({
      link_id: linkB.referenceId, link_amount: 11800, link_currency: 'INR', link_purpose: `Quotation ${quotationB.number}`,
      customer_details: { customer_phone: '9829070002', customer_name: 'Kiran Stores' }, link_partial_payments: true, link_minimum_partial_amount: 1000,
      link_notify: { send_sms: false, send_email: false }, link_expiry_time: expect.stringMatching(/\+05:30$/),
    });
    expect((await post(owner, '/payment-links', { quotationId: quotationB.id, amountPaise: 2000000 })).body.code).toBe('VALIDATION_ERROR'); // more than the quotation
    expect((await post(owner, '/payment-links', { quotationId: quotationB.id })).body.code).toBe('OPEN_LINK_EXISTS');
    expect((await post(owner, '/payment-links', { contactId: (await Conversation.findById(chat.conversationId)).contactId, amountPaise: 99 })).body.code).toBe('VALIDATION_ERROR');

    // ₹5,000 now, by Cashfree's webhook.
    const cfLink = gateway.cashfree.get(linkB.referenceId);
    Object.assign(cfLink, { link_status: 'PARTIALLY_PAID', link_amount_paid: 5000, orders: [{ cf_order_id: '1', order_id: 'CF_ORDER_1', order_status: 'PAID', order_amount: 5000, created_at: '2026-10-05T11:00:00+05:30' }] });
    const partial = {
      data: { cf_link_id: 1001, link_id: linkB.referenceId, link_status: 'PARTIALLY_PAID', link_amount_paid: '5000.00', order: { order_id: 'CF_ORDER_1', order_amount: '5000.00', transaction_id: 1, transaction_status: 'SUCCESS' } },
      type: 'PAYMENT_LINK_EVENT', event_time: '2026-10-05T11:00:00+05:30',
    };
    expect((await cashfreeHook(cashfreeConn, partial)).status).toBe(200);
    await settle();
    const quotation = await Quotation.findById(quotationB.id);
    expect(quotation.status).toBe('Accepted');
    const order = (await get(owner, `/orders/${quotation.orderId}`)).body.data;
    expect(order).toMatchObject({ quotationId: quotationB.id, paymentStatus: 'partly_paid', amountPaidPaise: 500000, duePaise: 680000 });
    expect((await Lead.findById(order.leadId)).stage).toBe('Won'); // the first payment wins the deal (D40)
    let link = (await get(owner, `/payment-links/${linkB.id}`)).body.data;
    expect(link).toMatchObject({ status: 'partially_paid', orderId: order.id, amountPaidPaise: 500000 });
    expect(link.receipts).toEqual([expect.objectContaining({ status: 'skipped', reason: expect.stringContaining('no receipt template') })]);

    // A receipt template is chosen (only approved ones); then the rest is found by the status check.
    const templates = (await get(owner, '/templates')).body.data;
    expect((await api().put('/api/v1/payments/settings').set(as(owner)).send({ receiptTemplateId: templates.find((t) => t.status === 'REJECTED').id })).status).toBe(400);
    const receiptTemplate = templates.find((t) => t.name === 'order_update');
    expect((await api().put('/api/v1/payments/settings').set(as(owner)).send({ receiptTemplateId: receiptTemplate.id })).body.data).toMatchObject({ receiptTemplateId: receiptTemplate.id, expiryDays: 7, sendReceipt: true });
    Object.assign(cfLink, { link_status: 'PAID', link_amount_paid: 11800 });
    cfLink.orders.push({ cf_order_id: '2', order_id: 'CF_ORDER_2', order_status: 'PAID', order_amount: 6800, created_at: '2026-10-05T12:00:00+05:30' });
    await PaymentLink.updateOne({ _id: linkA.id }, { $set: { lastSyncedAt: new Date() } });
    expect(await paymentLinks.syncOpenLinks()).toBe(1); // only the open link is asked about
    await settle();
    expect((await get(owner, `/orders/${order.id}`)).body.data).toMatchObject({ paymentStatus: 'paid', amountPaidPaise: 1180000, duePaise: 0, stage: 'Received' });
    link = (await get(owner, `/payment-links/${linkB.id}`)).body.data;
    expect(link).toMatchObject({ status: 'paid', amountPaidPaise: 1180000 });
    expect(link.payments.map((p) => p.providerPaymentId)).toEqual(['CF_ORDER_1', 'CF_ORDER_2']);
    expect(link.receipts.map((r) => r.status)).toEqual(['skipped', 'sent']);
    const templated = await Message.findOne({ conversationId: chat.conversationId, 'automation.kind': 'receipt' });
    expect(templated).toMatchObject({ type: 'template', template: { name: 'order_update', variables: ['Kiran Stores', '₹6,800.00'] } });
  });

  it('records payments by hand, pays a Delivered order through the test gateway, and cancels links', async () => {
    const chat = await chatWith('98290 70003', 'Meena Spices');
    const order = await orderFor(chat.conversationId);
    await post(owner, `/orders/${order.id}/stage`, { stage: 'Delivered' });
    const byHand = await api().post(`/api/v1/orders/${order.id}/payments`).set(as(owner)).send({ amountPaise: 180000, method: 'bank_transfer', reference: 'UTR998877' });
    expect(byHand.status).toBe(201);
    expect(byHand.body.data).toMatchObject({ paymentStatus: 'partly_paid', amountPaidPaise: 180000, duePaise: 1000000, stage: 'Delivered' });
    const manual = byHand.body.data.payments[0];
    expect(manual).toMatchObject({ source: 'manual', method: 'bank_transfer', reference: 'UTR998877', recordedByName: 'Asha' });
    expect((await api().delete(`/api/v1/orders/${orderA.id}/payments/${(await get(owner, `/orders/${orderA.id}`)).body.data.payments[0].id}`).set(as(owner))).body.code).toBe('GATEWAY_PAYMENT');
    expect((await api().delete(`/api/v1/orders/${order.id}/payments/${manual.id}`).set(as(owner))).body.data).toMatchObject({ paymentStatus: 'unpaid', amountPaidPaise: 0, payments: [] });
    await post(owner, `/orders/${order.id}/payments`, { amountPaise: 180000, method: 'cash' });

    // The test gateway: its link opens a payment page on this server.
    const mockConn = (await post(owner, '/payments/connections', { provider: 'mock' })).body.data;
    expect(mockConn).toMatchObject({ provider: 'mock', mode: 'test', webhookUrl: '' });
    const link = (await post(owner, '/payment-links', { orderId: order.id, connectionId: mockConn.id })).body.data;
    expect(link).toMatchObject({ provider: 'mock', amountPaise: 1000000 }); // what is still due
    const pagePath = new URL(link.shortUrl).pathname;
    expect(pagePath).toMatch(/^\/api\/v1\/webhooks\/payments-test\/mock_plink_[a-f0-9]{24}$/);
    const page = await api().get(pagePath);
    expect(page.status).toBe(200);
    expect(page.text).toContain('₹10,000.00');
    expect((await api().post(pagePath).type('form').send({})).text).toContain('Paid ₹10,000.00');
    await settle();
    const paid = (await get(owner, `/orders/${order.id}`)).body.data;
    expect(paid).toMatchObject({ paymentStatus: 'paid', amountPaidPaise: 1180000, stage: 'Payment Collected' });
    expect(paid.history.at(-1)).toMatchObject({ stage: 'Payment Collected', from: 'Delivered', note: 'Paid in full', byName: 'Test gateway' });
    expect((await api().get('/api/v1/webhooks/payments-test/mock_plink_000000000000000000000000')).status).toBe(404);

    // A link for an amount (an advance), then cancelled.
    const contactId = (await Conversation.findById(chat.conversationId)).contactId;
    const advance = (await post(owner, '/payment-links', { contactId, amountPaise: 50000, description: 'Advance for samples', connectionId: mockConn.id })).body.data;
    expect(advance).toMatchObject({ purpose: 'amount', amountPaise: 50000, description: 'Advance for samples', orderId: null });
    expect((await post(owner, `/payment-links/${advance.id}/cancel`, {})).body.data).toMatchObject({ status: 'cancelled' });
    expect((await post(owner, `/payment-links/${advance.id}/cancel`, {})).body.code).toBe('LINK_CLOSED');
    expect((await api().post(new URL(advance.shortUrl).pathname).type('form').send({})).text).toContain('This link is cancelled');
    // A Razorpay link cancelled at Razorpay too.
    const other = await orderFor((await chatWith('98290 70004', 'Bhavya Mart')).conversationId);
    const rzp = (await post(owner, '/payment-links', { orderId: other.id })).body.data;
    expect((await post(owner, `/payment-links/${rzp.id}/cancel`, {})).body.data).toMatchObject({ status: 'cancelled' });
    expect(gateway.razorpay.get(rzp.providerLinkId).status).toBe('cancelled');
    expect((await post(owner, '/payment-links', { orderId: other.id })).status).toBe(201); // a new one once the old is closed
  });

  it('sends a link in the chat, lists what is due, and reminds by workflow (8B)', async () => {
    const chat = await chatWith('98290 70006', 'Surat Mart');
    const order = await orderFor(chat.conversationId);
    let options = (await get(owner, `/payment-links/options?orderId=${order.id}`)).body.data;
    expect(options).toMatchObject({ blocked: '', purpose: 'order', amountPaise: 1180000, documentNumber: order.number, customerName: 'Surat Mart', openLink: null, expiryDays: 7 });
    expect(options.gateways.map((g) => g.provider)).toEqual(['razorpay', 'cashfree', 'mock']);
    const link = (await post(owner, '/payment-links', { orderId: order.id })).body.data;
    options = (await get(owner, `/payment-links/options?orderId=${order.id}`)).body.data;
    expect(options.openLink).toMatchObject({ id: link.id });
    expect(options.links.map((l) => l.id)).toEqual([link.id]);
    expect((await get(owner, `/payment-links/options?orderId=${orderA.id}`)).body.data.blocked).toMatch(/already paid/);

    // Inside the 24-hour window: a ready message with the link.
    let sendOptions = (await get(owner, `/payment-links/${link.id}/send-options`)).body.data;
    expect(sendOptions).toMatchObject({ blocked: '', windowOpen: true, preferredTemplateId: null });
    expect(sendOptions.text).toContain(`please pay ₹11,800.00 for order ${order.number}`);
    expect(sendOptions.text).toContain(link.shortUrl);
    expect(sendOptions.text).toMatch(/valid till \d{1,2} \w{3} 2026/);
    const sent = await api().post(`/api/v1/payment-links/${link.id}/send`).set(as(owner)).set('Idempotency-Key', 'pay-send-0001').send({ mode: 'text', text: sendOptions.text });
    expect(sent.status).toBe(200);
    expect(sent.body.data.link.sentAt).toBeTruthy();
    expect((await Message.findById(sent.body.data.message.id)).text).toContain(link.shortUrl);

    // A day later only a template may go; its URL button gets the end of the link.
    await Conversation.updateOne({ _id: chat.conversationId }, { lastInboundAt: new Date(Date.now() - 2 * 86400000) });
    sendOptions = (await get(owner, `/payment-links/${link.id}/send-options`)).body.data;
    expect(sendOptions.windowOpen).toBe(false);
    expect((await post(owner, `/payment-links/${link.id}/send`, { mode: 'text', text: 'Pay please' })).body.code).toBe('WINDOW_CLOSED');
    const template = sendOptions.templates.find((t) => t.name === 'order_update');
    expect(template.suggested.body).toEqual({ 1: 'Surat Mart', 2: '₹11,800.00' });
    expect(paymentLinks.buttonSuffix('https://rzp.io/i/{{1}}', 'https://rzp.io/i/T9')).toBe('T9');
    expect(paymentLinks.buttonSuffix('https://pay.example.com/{{1}}', 'https://rzp.io/i/T9')).toBe('');
    const byTemplate = await post(owner, `/payment-links/${link.id}/send`, { mode: 'template', templateId: template.id, variables: { body: template.suggested.body } });
    expect(byTemplate.status).toBe(200);
    expect(byTemplate.body.data.message).toMatchObject({ type: 'template', template: { name: 'order_update', variables: ['Surat Mart', '₹11,800.00'] } });

    // What is due: oldest first, with totals by age and the open link.
    await Order.updateOne({ _id: order.id }, { $set: { orderDate: new Date(Date.now() - 40 * 86400000) } });
    const dues = (await get(owner, '/orders/dues')).body.data;
    expect(dues.items[0]).toMatchObject({ id: order.id, duePaise: 1180000, paymentStatus: 'unpaid', daysOutstanding: 40, bucket: '31-60', customer: { name: 'Surat Mart' }, openLink: { id: link.id } });
    expect(dues.items.every((item) => item.duePaise > 0)).toBe(true);
    expect(dues.items.map((item) => item.id)).not.toContain(orderA.id); // paid
    expect(dues.summary.count).toBe(dues.items.length);
    expect(dues.summary.duePaise).toBe(dues.items.reduce((sum, item) => sum + item.duePaise, 0));
    expect(dues.summary.buckets['31-60']).toMatchObject({ count: 1, duePaise: 1180000 });
    expect((await get(owner, '/orders/dues?minDays=30')).body.data.items.map((item) => item.id)).toEqual([order.id]);
    expect((await get(agent, '/orders/dues')).body.data.items).toEqual([]);

    // A reminder workflow: unpaid 30 days after the order → the payment link goes again.
    engine.register(queue);
    await Conversation.updateOne({ _id: chat.conversationId }, { lastInboundAt: new Date() });
    const workflow = (await post(owner, '/workflows', { name: 'Payment reminder', status: 'Active', trigger: { type: 'payment.overdue', params: { days: 30 } }, steps: [{ type: 'payment.link' }] })).body.data;
    expect(workflow).toMatchObject({ trigger: { type: 'payment.overdue', params: { days: 30 } }, steps: [{ type: 'payment.link' }] });
    expect(await engine.scan(queue)).toBe(1);
    await settle();
    const run = (await get(owner, `/automation-runs?workflowId=${workflow.id}`)).body.data[0];
    expect(run).toMatchObject({ status: 'done', subject: { orderId: order.id }, steps: [{ type: 'payment.link', status: 'done' }] });
    expect(run.steps[0].detail).toContain('₹11,800.00');
    const reminder = await Message.findOne({ conversationId: chat.conversationId, 'automation.kind': 'workflow' }).sort({ createdAt: -1 });
    expect(reminder.text).toContain(link.shortUrl); // the open link, not a new one
    expect(await PaymentLink.countDocuments({ orderId: order.id })).toBe(1);
    expect(await engine.scan(queue)).toBe(0); // once per order and amount paid
  });

  it('keeps links to the right people, and needs a plan with payment links', async () => {
    expect((await get(agent, '/payment-links')).body.data).toEqual([]); // the agent owns none of these customers
    expect((await get(agent, `/payment-links/${linkA.id}`)).status).toBe(404);
    expect((await get(owner, '/payment-links')).body.data.length).toBeGreaterThanOrEqual(5);
    expect((await get(owner, `/payment-links?orderId=${orderA.id}`)).body.data.map((l) => l.id)).toEqual([linkA.id]);
    expect((await get(stranger, '/payment-links')).body.data).toEqual([]);
    expect((await get(stranger, `/payment-links/${linkA.id}`)).status).toBe(404);
    expect((await post(stranger, '/payment-links', { orderId: orderA.id })).status).toBe(404);

    // Another company's Razorpay webhook naming this company's link changes nothing.
    const theirs = (await post(stranger, '/payments/connections', { provider: 'razorpay', ...RZP })).body.data;
    const before = await InboundEvent.countDocuments({ status: 'ignored' });
    const forged = {
      event: 'payment_link.paid',
      payload: { payment_link: { entity: { id: rzpOpenLinkId(), amount: 1180000, amount_paid: 1180000, status: 'paid' } }, payment: { entity: { id: 'pay_Forged', amount: 1180000, method: 'upi', status: 'captured' } } },
    };
    expect((await razorpayHook(theirs, forged, 'evt_forged')).status).toBe(200);
    await settle();
    expect(await InboundEvent.countDocuments({ status: 'ignored' })).toBe(before + 1);
    expect(await PaymentLink.exists({ 'payments.providerPaymentId': 'pay_Forged' })).toBeNull();

    const org = await Organization.findOne({ name: 'Yellow Traders' });
    await Organization.updateOne({ _id: org._id }, { $set: { plan: 'starter' } });
    const chat = await chatWith('98290 70005', 'Small Shop');
    const contactId = (await Conversation.findById(chat.conversationId)).contactId;
    const refused = await post(owner, '/payment-links', { contactId, amountPaise: 10000 });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('PLAN_LIMIT');
    await Organization.updateOne({ _id: org._id }, { $set: { plan: 'growth' } });
  });

  // The newest open Razorpay link of this company.
  function rzpOpenLinkId() {
    return [...gateway.razorpay.values()].filter((l) => l.status === 'created').at(-1).id;
  }
});
