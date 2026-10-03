jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const QRCode = require('qrcode');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Product = require('../models/Product');
const Quotation = require('../models/Quotation');
const inbound = require('../services/whatsappInboundService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 5 acceptance: a WhatsApp enquiry becomes a GST quotation, the PDF goes into the chat,
// the customer opens the link, accepts, and the order is dispatched and paid — through the real
// Cloud API code (Meta replaced by a fake fetch), with another company seeing none of it.
const APP_SECRET = 'p5-app-secret-0123456789';
const TOKEN = 'EAAG-p5-token-4455';
const PHONE_NUMBER_ID = '5550005555';
const WABA_ID = '4440005555';
const CUSTOMER = '919824012345';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sign = (raw) => `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
const now = () => String(Math.floor(Date.now() / 1000));
const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};
const TEMPLATES = [
  {
    id: '9201', name: 'quotation_pdf', language: 'en', status: 'APPROVED', category: 'UTILITY',
    components: [{ type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: 'Namaste {{1}}, please find our quotation {{2}} for {{3}} attached.' }],
  },
  { id: '9202', name: 'order_update', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Namaste {{1}}, your order {{2}} has been dispatched.' }] },
];

describe('Phase 5 acceptance: from a WhatsApp enquiry to a paid order', () => {
  const graph = []; // what the CRM sent to Meta
  let uploads = 0;
  let sends = 0;

  beforeAll(() => {
    jest.spyOn(global, 'fetch').mockImplementation(async (target, options = {}) => {
      const url = String(target);
      const method = options.method || 'GET';
      if (url.includes('/message_templates')) return json({ data: TEMPLATES });
      if (url.endsWith(`/${PHONE_NUMBER_ID}/media`) && method === 'POST') {
        uploads += 1;
        const file = options.body.get('file');
        graph.push({ kind: 'upload', type: options.body.get('type'), fileName: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
        return json({ id: `MEDIA-OUT-${uploads}` });
      }
      if (url.endsWith(`/${PHONE_NUMBER_ID}/messages`) && method === 'POST') {
        sends += 1;
        graph.push({ kind: 'message', body: JSON.parse(options.body) });
        return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.P5OUT${sends}` }] });
      }
      return json({ display_phone_number: '+91 90000 55555', verified_name: 'Yellow Traders', quality_rating: 'GREEN' });
    });
  });
  afterAll(() => jest.restoreAllMocks());

  it('works end to end, for the right people only', async () => {
    // --- 1. The company is set up: GST details, logo, bank and UPI, a product with stock ---
    const owner = await login('p5-owner@example.com', { name: 'Asha' });
    const agent = await inviteAndJoin(owner.token, 'p5-agent@example.com', { role: 'agent', displayName: 'Arun' });
    const other = await inviteAndJoin(owner.token, 'p5-other@example.com', { role: 'agent', displayName: 'Bela' });
    const stranger = await login('p5-stranger@example.com');
    const as = (user) => bearer(user.token);
    await api().patch('/api/v1/organization').set(as(owner)).send({ name: 'Yellow Traders', gstin: '08AAACY1234C1Z5', address: '12 MI Road', city: 'Jaipur', phone: '+91 98290 00000' });
    await api().post('/api/v1/organization/logo').set(as(owner)).attach('logo', await QRCode.toBuffer('logo', { type: 'png' }), 'logo.png');
    await api().put('/api/v1/organization/billing').set(as(owner)).send({
      bank: { accountName: 'Yellow Traders', accountNumber: '50100012345678', ifsc: 'HDFC0001234' }, upiId: 'yellowtraders@okhdfcbank',
      terms: '50% advance, balance before dispatch.', reduceStockOnDispatch: true,
    });
    const product = (await api().post('/api/v1/products').set(as(owner)).send({ name: 'Steel Rack', unit: 'pcs', hsnSac: '9403', pricePaise: 899950, gstRatePct: 18, stockQty: 100 })).body.data;
    const account = (await api().post('/api/v1/whatsapp/accounts').set(as(owner)).send({ name: 'Sales', phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, accessToken: TOKEN, appSecret: APP_SECRET })).body.data;
    const templates = Object.fromEntries((await api().post('/api/v1/templates/sync').set(as(owner)).send({})).body.data.map((t) => [t.name, t]));
    expect(templates.quotation_pdf).toMatchObject({ documentHeader: true });

    // --- 2. A customer writes on WhatsApp; Arun answers and so owns the chat and the lead ---
    const webhook = async (messages) => {
      const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_NUMBER_ID }, contacts: [{ profile: { name: 'Surat Mart' }, wa_id: CUSTOMER }], messages } }] }] });
      expect((await api().post(account.webhookPath).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw)).send(raw)).status).toBe(200);
      await inbound.idle();
    };
    await webhook([{ from: CUSTOMER, id: 'wamid.P5IN1', timestamp: now(), type: 'text', text: { body: 'Steel rack 10 pcs ka rate? GSTIN 24AAACS1234C1Z5' } }]);
    const conversation = await Conversation.findOne({ whatsappAccountId: account.id });
    await api().post(`/api/v1/conversations/${conversation._id}/messages`).set(as(agent)).send({ text: 'Ji, quotation bhej rahe hain.' });
    const lead = await Lead.findOne({ contactId: conversation.contactId });
    const agentId = (await api().get('/api/v1/members').set(as(owner))).body.data.find((m) => m.email === 'p5-agent@example.com').id;
    expect(String(lead.ownerId)).toBe(agentId);

    // --- 3. Arun makes the quotation from the chat: Gujarat GSTIN → IGST; discount; freight ---
    const firstLook = (await api().post('/api/v1/pricing/preview').set(as(agent)).send({ conversationId: String(conversation._id), items: [{ productId: product.id, quantity: 10 }] })).body.data;
    expect(firstLook.supply).toMatchObject({ stateAssumed: true, interState: false });
    const created = await api().post('/api/v1/quotations').set(as(agent)).set('Idempotency-Key', 'p5-quote-0001').send({
      conversationId: String(conversation._id),
      billTo: { gstin: '24AAACS1234C1Z5', company: 'Surat Mart LLP', address: 'Ring Road', city: 'Surat' },
      items: [
        { productId: product.id, quantity: 10, discountType: 'percent', discountValue: 5 },
        { name: 'Freight to Surat', hsnSac: '996511', unit: 'trip', quantity: 1, unitPricePaise: 250000, gstRatePct: 18 },
      ],
    });
    expect(created.status).toBe(201);
    const quotation = created.body.data;
    // 10 × ₹8,999.50 = ₹89,995.00 − 5% = ₹85,495.25 + freight ₹2,500 = ₹87,995.25 taxable; IGST 18% = ₹15,839.15 (per line,
    // to the paisa: 15,389.15 + 450.00); total ₹1,03,834.40 → ₹1,03,834.00.
    expect(quotation).toMatchObject({
      leadId: String(lead._id), ownerId: agentId, billTo: { name: 'Surat Mart', gstin: '24AAACS1234C1Z5', stateCode: '24' },
      supply: { placeOfSupplyCode: '24', interState: true, stateAssumed: false },
      totals: { taxablePaise: 8799525, igstPaise: 1583915, cgstPaise: 0, roundOffPaise: -40, grandTotalPaise: 10383400 },
    });
    expect((await Contact.findById(conversation.contactId)).gstin).toBe('24AAACS1234C1Z5'); // the blank field filled in

    // --- 4. The PDF goes into the chat (the window is open): uploaded, then sent as a document ---
    const options = (await api().get(`/api/v1/quotations/${quotation.id}/send-options`).set(as(agent))).body.data;
    expect(options).toMatchObject({ blocked: '', conversation: { windowOpen: true } });
    const sent = await api().post(`/api/v1/quotations/${quotation.id}/send`).set(as(agent)).set('Idempotency-Key', 'p5-send-0001').send({ mode: 'document', caption: options.caption });
    expect(sent.status).toBe(200);
    const upload = graph.find((g) => g.kind === 'upload');
    expect(upload).toMatchObject({ type: 'application/pdf', fileName: `${quotation.number.replace(/\//g, '-')}.pdf` });
    expect(upload.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(graph.at(-1).body).toMatchObject({ to: CUSTOMER, type: 'document', document: { id: 'MEDIA-OUT-1', filename: upload.fileName } });
    expect(graph.at(-1).body.document.caption).toContain(quotation.shareUrl);
    expect(sent.body.data.quotation).toMatchObject({ status: 'Sent', sentVia: 'whatsapp' });
    expect((await Lead.findById(lead._id)).stage).toBe('Quote Sent');

    // --- 5. Days pass without a reply: the quotation shows under "Quote sent, no reply" ---
    await Quotation.updateOne({ _id: quotation.id }, { sentAt: new Date(Date.now() - 4 * 86400000) });
    await Conversation.updateOne({ _id: conversation._id }, { lastInboundAt: new Date(Date.now() - 5 * 86400000) });
    const waiting = (await api().get('/api/v1/quotations/awaiting-reply?days=3').set(as(agent))).body.data;
    expect(waiting).toEqual([expect.objectContaining({ waitingDays: 4, quotation: expect.objectContaining({ number: quotation.number, viewCount: 0 }) })]);
    expect((await api().get('/api/v1/quotations/awaiting-reply?days=3').set(as(other))).body.data).toEqual([]); // not Bela's lead

    // --- 6. The customer opens the link (marks Viewed), then replies; the PDF opens from the link ---
    const link = new URL(quotation.shareUrl).pathname;
    const page = await api().get(link);
    expect(page.status).toBe(200);
    expect(page.text).toContain('₹1,03,834.00');
    expect(page.text).toContain('IGST');
    expect((await Quotation.findById(quotation.id)).status).toBe('Viewed');
    expect(await LeadActivity.exists({ leadId: lead._id, text: /opened by the customer$/ })).toBeTruthy();
    expect((await api().get(`${link}/pdf`).buffer(true).parse(binary)).body.subarray(0, 5).toString()).toBe('%PDF-');
    await webhook([{ from: CUSTOMER, id: 'wamid.P5IN2', timestamp: now(), type: 'text', text: { body: 'OK, confirmed. Please dispatch.' } }]);
    expect((await api().get('/api/v1/quotations/awaiting-reply?days=3').set(as(agent))).body.data).toEqual([]);

    // --- 7. Accepted → order; dispatched with the LR number; the customer is told on WhatsApp ---
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(as(agent)).send({ status: 'Accepted' });
    const order = (await api().post('/api/v1/orders').set(as(agent)).set('Idempotency-Key', 'p5-order-0001').send({ quotationId: quotation.id })).body.data;
    expect(order).toMatchObject({ stage: 'Received', totals: { grandTotalPaise: 10383400 }, ownerId: agentId });
    const dispatched = (await api().post(`/api/v1/orders/${order.id}/stage`).set(as(agent)).send({ stage: 'Dispatched', dispatch: { transporter: 'VRL Logistics', lrNumber: 'LR-55120' } })).body.data;
    expect(dispatched.dispatch).toMatchObject({ transporter: 'VRL Logistics', lrNumber: 'LR-55120' });
    expect((await Product.findById(product.id)).stockQty).toBe(90);
    const textUpdate = (await api().get(`/api/v1/orders/${order.id}/notify-options`).set(as(agent))).body.data;
    expect(textUpdate).toMatchObject({ windowOpen: true });
    await api().post(`/api/v1/orders/${order.id}/notify`).set(as(agent)).send({ mode: 'text', text: textUpdate.text });
    expect(graph.at(-1).body).toMatchObject({ type: 'text', text: { body: `Namaste Surat Mart, your order ${order.number} has been dispatched by VRL Logistics (LR no. LR-55120).` } });
    // A day later the window has closed: the next update is the approved template.
    await Conversation.updateOne({ _id: conversation._id }, { lastInboundAt: new Date(Date.now() - 30 * 3600 * 1000) });
    await api().post(`/api/v1/orders/${order.id}/stage`).set(as(agent)).send({ stage: 'Delivered' });
    const templateUpdate = (await api().get(`/api/v1/orders/${order.id}/notify-options`).set(as(agent))).body.data;
    const orderUpdate = templateUpdate.templates.find((t) => t.name === 'order_update');
    expect((await api().post(`/api/v1/orders/${order.id}/notify`).set(as(agent)).send({ mode: 'template', templateId: orderUpdate.id, variables: { body: orderUpdate.suggested.body } })).status).toBe(200);
    expect(graph.at(-1).body).toMatchObject({ type: 'template', template: { name: 'order_update', components: [{ type: 'body', parameters: [{ text: 'Surat Mart' }, { text: order.number }] }] } });

    // --- 8. Paid: the lead is won and the customer is a customer ---
    const paid = (await api().post(`/api/v1/orders/${order.id}/stage`).set(as(agent)).send({ stage: 'Payment Collected' })).body.data;
    expect(paid.history.map((h) => h.stage)).toEqual(['Received', 'Dispatched', 'Delivered', 'Payment Collected']);
    expect((await Lead.findById(lead._id)).stage).toBe('Won');
    expect((await Contact.findById(conversation.contactId)).lifecycle).toBe('customer');
    const timeline = (await LeadActivity.find({ leadId: lead._id }).sort({ createdAt: 1 })).map((a) => a.text);
    expect(timeline).toEqual(expect.arrayContaining([
      expect.stringMatching(/ sent on WhatsApp$/), expect.stringMatching(/ accepted$/), expect.stringMatching(/^Order .+ received/),
      expect.stringMatching(/Received → Dispatched \(VRL Logistics, LR LR-55120\)$/), expect.stringMatching(/Delivered → Payment Collected$/),
    ]));

    // --- 9. The owner's backup has it all; nobody else sees any of it ---
    const backup = await api().get('/api/v1/exports/crm').set(as(owner));
    expect(backup.text).toContain(order.number);
    expect(backup.text).toContain(quotation.number);
    // Bela (a teammate without the lead) and another company: 404 everywhere.
    for (const user of [other, stranger]) {
      const statuses = [
        (await api().get(`/api/v1/quotations/${quotation.id}`).set(as(user))).status,
        (await api().get(`/api/v1/quotations/${quotation.id}/pdf`).set(as(user))).status,
        (await api().get(`/api/v1/orders/${order.id}`).set(as(user))).status,
        (await api().post(`/api/v1/orders/${order.id}/stage`).set(as(user)).send({ stage: 'Cancelled', cancelReason: 'x' })).status,
      ];
      expect(statuses).toEqual([404, 404, 404, 404]);
    }
    expect((await api().get('/api/v1/orders').set(as(stranger))).body.data).toEqual([]);
    expect((await api().post('/api/v1/pricing/preview').set(as(stranger)).send({ conversationId: String(conversation._id), items: [] })).status).toBe(404);
    expect((await api().get(`${link.slice(0, -2)}xx`)).status).toBe(404);
  });
});
