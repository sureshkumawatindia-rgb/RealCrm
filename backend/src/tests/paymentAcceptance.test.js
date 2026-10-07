jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const jobs = require('../jobs');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const Notification = require('../models/Notification');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Quotation = require('../models/Quotation');
const inbound = require('../services/whatsappInboundService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 8 acceptance (brief, test 3): the agent chats, sends a GST quotation PDF in the chat,
// then a payment link; the payment marks the order paid and moves the lead to Won — and a cart
// from the WhatsApp catalog becomes an order that is paid in two parts. Through the real code:
// the job worker, the Cloud API sender (Meta faked at fetch), the Razorpay client (faked at
// fetch), signed WhatsApp and Razorpay webhooks; another company sees none of it.
const APP_SECRET = 'p8-app-secret-0123456789';
const PHONE_NUMBER_ID = '5550009999';
const WABA_ID = '4440009999';
const CATALOG_ID = '777000111222';
const CUSTOMER = '919829091001';
const RZP = { keyId: 'rzp_test_P8ACCEPT01', keySecret: 'p8-rzp-key-secret', webhookSecret: 'p8-rzp-webhook-secret' };
const TEMPLATES = [
  { id: '9801', name: 'quotation_pdf', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: 'Namaste {{1}}, please find our quotation {{2}} for {{3}} attached.' }] },
  { id: '9802', name: 'payment_receipt', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Namaste {{1}}, we have received your payment of {{2}} for order {{3}}. Payment ID: {{4}}.' }] },
];

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const signMeta = (raw) => `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
const signRazorpay = (raw) => crypto.createHmac('sha256', RZP.webhookSecret).update(raw).digest('hex');
const now = () => String(Math.floor(Date.now() / 1000));
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

describe('Phase 8 acceptance: from a quotation in the chat to a paid order, and a catalog cart paid in parts', () => {
  const meta = []; // what the CRM sent to Meta
  const razorpay = new Map(); // payment links at the fake Razorpay
  let sends = 0;
  let plinks = 0;

  beforeAll(() => {
    jest.spyOn(global, 'fetch').mockImplementation(async (target, options = {}) => {
      const url = String(target);
      const method = options.method || 'GET';
      const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
      if (url.startsWith('https://api.razorpay.com/v1/')) {
        if (options.headers.Authorization !== `Basic ${Buffer.from(`${RZP.keyId}:${RZP.keySecret}`).toString('base64')}`) return json({ error: { description: 'Authentication failed' } }, 401);
        if (url.endsWith('/payment_links?count=1')) return json({ count: 0, payment_links: [] });
        if (url.endsWith('/payment_links') && method === 'POST') {
          plinks += 1;
          const link = { id: `plink_P8A${plinks}`, short_url: `https://rzp.io/i/P8A${plinks}`, status: 'created', amount: body.amount, amount_paid: 0, expire_by: body.expire_by, reference_id: body.reference_id, payments: [] };
          razorpay.set(link.id, link);
          return json(link);
        }
        const one = /\/payment_links\/(plink_\w+)$/.exec(url);
        if (one) return json(razorpay.get(one[1]));
      }
      if (url.includes('/message_templates')) return json({ data: TEMPLATES });
      if (url.includes(`/${CATALOG_ID}?fields=`)) return json({ id: CATALOG_ID, name: 'Yellow Traders', product_count: 0 });
      if (url.endsWith(`/${CATALOG_ID}/items_batch`)) {
        meta.push({ kind: 'catalog', body });
        return json({ handles: ['h'], validation_status: [] });
      }
      if (url.includes('/whatsapp_commerce_settings')) return json({ success: true });
      if (url.endsWith(`/${PHONE_NUMBER_ID}/media`) && method === 'POST') return json({ id: `MEDIA-P8-${meta.length}` });
      if (url.endsWith(`/${PHONE_NUMBER_ID}/messages`) && method === 'POST') {
        sends += 1;
        meta.push({ kind: 'message', body });
        return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.P8OUT${sends}` }] });
      }
      return json({ display_phone_number: '+91 90000 99999', verified_name: 'Yellow Traders', quality_rating: 'GREEN' });
    });
  });
  afterAll(async () => {
    await jobs.stop();
    jest.restoreAllMocks();
  });

  it('works end to end, for the right people only', async () => {
    // --- 1. The company: GST details, a product, WhatsApp, Razorpay, a receipt template; an agent ---
    const owner = await login('p8-owner@example.com', { name: 'Asha' });
    const agent = await inviteAndJoin(owner.token, 'p8-agent@example.com', { role: 'agent', displayName: 'Arun', modules: ['inbox', 'leads', 'deals', 'products'] });
    const stranger = await login('p8-stranger@example.com');
    const as = (user) => bearer(user.token);
    const post = (user, path, body) => api().post(`/api/v1${path}`).set(as(user)).send(body);
    const get = (user, path) => api().get(`/api/v1${path}`).set(as(user));
    await api().patch('/api/v1/organization').set(as(owner)).send({ name: 'Yellow Traders', gstin: '08AAACY1234C1Z5', address: '12 MI Road', city: 'Jaipur', website: 'https://yellowtraders.example' });
    const product = (await post(owner, '/products', { name: 'Jeera 25kg', sku: 'JEERA-25', category: 'Spices', unit: 'bag', hsnSac: '0909', pricePaise: 300000, gstRatePct: 5, images: ['https://cdn.example.com/jeera.jpg'] })).body.data;
    const account = (await post(owner, '/whatsapp/accounts', { name: 'Sales', phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: 'EAAG-p8-token-7788', appSecret: APP_SECRET })).body.data;
    const templates = Object.fromEntries((await post(owner, '/templates/sync', {})).body.data.map((t) => [t.name, t]));
    const gateway = (await post(owner, '/payments/connections', { provider: 'razorpay', ...RZP })).body.data;
    expect(gateway).toMatchObject({ status: 'connected', mode: 'test' });
    await api().put('/api/v1/payments/settings').set(as(owner)).send({ receiptTemplateId: templates.payment_receipt.id });
    jobs.start({ pollMs: 200 });

    const whatsapp = async (messages) => {
      const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_NUMBER_ID }, contacts: [{ profile: { name: 'Surat Mart' }, wa_id: CUSTOMER }], messages } }] }] });
      expect((await api().post(account.webhookPath).set('Content-Type', 'application/json').set('X-Hub-Signature-256', signMeta(raw)).send(raw)).status).toBe(200);
      await inbound.idle();
    };
    const razorpayPays = async (link, paymentId, amount, status = 'paid') => {
      const state = razorpay.get(link.providerLinkId);
      state.amount_paid += amount;
      state.status = status;
      state.payments.push({ payment_id: paymentId, amount, method: 'upi', status: 'captured', created_at: Math.floor(Date.now() / 1000) });
      const raw = JSON.stringify({
        event: `payment_link.${status}`,
        payload: { payment_link: { entity: { id: state.id, amount: state.amount, amount_paid: state.amount_paid, status, reference_id: link.referenceId } }, payment: { entity: { id: paymentId, amount, method: 'upi', status: 'captured', created_at: Math.floor(Date.now() / 1000) } } },
      });
      expect((await api().post(gateway.webhookPath).set('Content-Type', 'application/json').set('X-Razorpay-Signature', signRazorpay(raw)).set('X-Razorpay-Event-Id', `evt_${paymentId}`).send(raw)).status).toBe(200);
    };

    // --- 2. A customer writes; Arun answers, so the chat and the new lead are his -------------------
    await whatsapp([{ from: CUSTOMER, id: 'wamid.P8IN1', timestamp: now(), type: 'text', text: { body: '20 bag jeera ka rate? GSTIN 24AAACS1234C1Z5' } }]);
    const conversation = await Conversation.findOne({ whatsappAccountId: account.id });
    await post(agent, `/conversations/${conversation._id}/messages`, { type: 'text', text: 'Namaste! Quotation bhej raha hoon.' });
    const agentId = (await get(owner, '/members')).body.data.find((m) => m.email === 'p8-agent@example.com').id;
    const lead = await Lead.findOne({ contactId: conversation.contactId });
    expect(String(lead.ownerId)).toBe(agentId);

    // --- 3. The GST quotation goes into the chat as a PDF ------------------------------------------
    const quotation = (await post(agent, '/quotations', { conversationId: String(conversation._id), billTo: { gstin: '24AAACS1234C1Z5', company: 'Surat Mart LLP', city: 'Surat' }, items: [{ productId: product.id, quantity: 20 }] })).body.data;
    // 20 × ₹3,000 = ₹60,000 + IGST 5% (Gujarat) = ₹63,000.
    expect(quotation).toMatchObject({ supply: { interState: true }, totals: { taxablePaise: 6000000, igstPaise: 300000, grandTotalPaise: 6300000 } });
    const sentPdf = await post(agent, `/quotations/${quotation.id}/send`, { mode: 'document', caption: 'Our quotation' });
    expect(sentPdf.status).toBe(200);
    expect(meta.filter((m) => m.kind === 'message').at(-1).body).toMatchObject({ to: CUSTOMER, type: 'document' });
    expect((await Lead.findById(lead._id)).stage).toBe('Quote Sent');

    // --- 4. Then the payment link, in the chat ---------------------------------------------------
    const options = (await get(agent, `/payment-links/options?quotationId=${quotation.id}`)).body.data;
    expect(options).toMatchObject({ blocked: '', purpose: 'quotation', amountPaise: 6300000, gateways: [{ provider: 'razorpay' }] });
    const link = (await post(agent, '/payment-links', { quotationId: quotation.id })).body.data;
    expect(link).toMatchObject({ provider: 'razorpay', amountPaise: 6300000, status: 'created', shortUrl: 'https://rzp.io/i/P8A1' });
    const sendOptions = (await get(agent, `/payment-links/${link.id}/send-options`)).body.data;
    expect(sendOptions).toMatchObject({ blocked: '', windowOpen: true });
    expect((await post(agent, `/payment-links/${link.id}/send`, { mode: 'text', text: sendOptions.text })).status).toBe(200);
    expect(meta.filter((m) => m.kind === 'message').at(-1).body).toMatchObject({ to: CUSTOMER, type: 'text', text: { body: expect.stringContaining('https://rzp.io/i/P8A1') } });

    // --- 5. The customer pays: the order is made and paid, the lead is won, a receipt goes ----------
    await razorpayPays(link, 'pay_P8Full1', 6300000);
    const order = await until(async () => {
      const found = await Order.findOne({ quotationId: quotation.id });
      return found?.amountPaidPaise === 6300000 && found;
    }, 'the paid order');
    expect((await Quotation.findById(quotation.id)).status).toBe('Accepted');
    expect(String(order.ownerId)).toBe(agentId);
    const seen = (await get(agent, `/orders/${order._id}`)).body.data;
    expect(seen).toMatchObject({ paymentStatus: 'paid', duePaise: 0, payments: [{ source: 'link', provider: 'razorpay', providerPaymentId: 'pay_P8Full1' }] });
    await until(async () => (await Lead.findById(lead._id)).stage === 'Won', 'the lead to be won');
    expect((await Contact.findById(conversation.contactId)).lifecycle).toBe('customer');
    const receipt = await until(() => meta.find((m) => m.kind === 'message' && m.body.type === 'text' && m.body.text.body.includes('pay_P8Full1')), 'the receipt');
    expect(receipt.body.text.body).toContain(`we have received your payment of ₹63,000.00 for order ${order.number}`);
    await until(() => Notification.findOne({ title: 'Payment received: ₹63,000.00', memberId: agentId }), 'Arun\'s bell');

    // --- 6. The catalog: the product goes to Meta; a cart comes back and becomes an order -----------
    const connected = await api().put(`/api/v1/whatsapp/accounts/${account.id}/catalog`).set(as(owner)).send({ catalogId: CATALOG_ID, catalogVisible: true, cartEnabled: true });
    expect(connected.status).toBe(200);
    await api().patch(`/api/v1/products/${product.id}`).set(as(owner)).send({ inCatalog: true });
    await post(owner, '/products/whatsapp-catalog/sync', {});
    expect((await Product.findById(product.id)).catalog).toMatchObject({ status: 'synced', retailerId: 'JEERA-25' });
    expect(meta.find((m) => m.kind === 'catalog').body.requests).toEqual([expect.objectContaining({ method: 'UPDATE', data: expect.objectContaining({ id: 'JEERA-25', price: '3150.00 INR' }) })]);
    expect((await post(agent, `/conversations/${conversation._id}/products`, { productIds: [product.id] })).status).toBe(201);
    await whatsapp([{ from: CUSTOMER, id: 'wamid.P8CART1', timestamp: now(), type: 'order', order: { catalog_id: CATALOG_ID, product_items: [{ product_retailer_id: 'JEERA-25', quantity: 10, item_price: 3150, currency: 'INR' }] } }]);
    const cartOrder = await until(() => Order.findOne({ source: 'catalog' }), 'the catalog order');
    // 10 × ₹3,000 + IGST 5% (the customer's GSTIN is in Gujarat now) = ₹31,500.
    expect(cartOrder).toMatchObject({ stage: 'Received', totals: { grandTotalPaise: 3150000 } });
    expect(String(cartOrder.ownerId)).toBe(agentId); // the chat is Arun's
    await until(() => meta.find((m) => m.kind === 'message' && m.body.text?.body?.includes(`order ${cartOrder.number}`)), 'the thank-you');

    // --- 7. A link for it, paid in two parts: by webhook, then found by "Check now" ---------------
    const partLink = (await post(agent, '/payment-links', { orderId: String(cartOrder._id), acceptPartial: true, minPartialPaise: 500000 })).body.data;
    expect(partLink).toMatchObject({ amountPaise: 3150000, acceptPartial: true });
    await razorpayPays(partLink, 'pay_P8Part1', 1000000, 'partially_paid');
    await until(async () => (await Order.findById(cartOrder._id)).amountPaidPaise === 1000000, 'the first part');
    expect((await get(agent, '/orders/dues')).body.data.items).toEqual([expect.objectContaining({ number: cartOrder.number, duePaise: 2150000, openLink: expect.objectContaining({ id: partLink.id }) })]);
    // The second part reaches Razorpay but its webhook never reaches the CRM (no public address).
    const state = razorpay.get(partLink.providerLinkId);
    state.amount_paid = 3150000;
    state.status = 'paid';
    state.payments.push({ payment_id: 'pay_P8Part2', amount: 2150000, method: 'card', status: 'captured', created_at: Math.floor(Date.now() / 1000) });
    expect((await post(agent, `/payment-links/${partLink.id}/refresh`, {})).body.data).toMatchObject({ status: 'paid', amountPaidPaise: 3150000 });
    expect((await get(agent, `/orders/${cartOrder._id}`)).body.data).toMatchObject({ paymentStatus: 'paid', payments: [{ providerPaymentId: 'pay_P8Part1' }, { providerPaymentId: 'pay_P8Part2', method: 'card' }] });
    expect((await get(agent, '/orders/dues')).body.data.items).toEqual([]);

    // --- 8. Nobody else ---------------------------------------------------------------------------
    expect((await get(stranger, `/payment-links/${link.id}`)).status).toBe(404);
    expect((await get(stranger, '/payment-links')).body.data).toEqual([]);
    expect((await get(stranger, `/orders/${order._id}`)).status).toBe(404);
    expect((await get(stranger, '/orders/dues')).body.data.items).toEqual([]);
    expect((await get(stranger, '/products/whatsapp-catalog')).body.data.catalogs).toEqual([]);
    expect((await get(agent, '/payments/connections')).status).toBe(403);
  }, 120000);
});
