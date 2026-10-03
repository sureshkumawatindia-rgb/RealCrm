jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mock = require('../integrations/whatsapp/mock');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Quotation = require('../models/Quotation');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 5E: orders from accepted quotations, the stage pipeline, dispatch details, stock,
// WhatsApp updates; and the "Quote Sent, no reply for N days" view.
describe('Orders', () => {
  let owner;
  let templates;
  let product;
  let contact;
  let lead;
  let quotation;
  let order;
  const auth = () => bearer(owner.token);
  const post = (path, body, token = owner.token) => api().post(`/api/v1${path}`).set(bearer(token)).send(body);
  const stage = (id, body) => post(`/orders/${id}/stage`, body);
  const stock = async () => (await Product.findById(product.id)).stockQty;
  let sent = [];
  let wamids = 0;

  beforeAll(async () => {
    owner = await login('order-owner@example.com', { name: 'Asha' });
    await api().patch('/api/v1/organization').set(auth()).send({ name: 'Yellow Traders', gstin: '08AAACY1234C1Z5' });
    await api().put('/api/v1/organization/billing').set(auth()).send({ reduceStockOnDispatch: true });
    await post('/whatsapp/accounts', { provider: 'mock' });
    templates = Object.fromEntries((await post('/templates/sync', {})).body.data.map((t) => [t.name, t]));
    product = (await post('/products', { name: 'Cumin Seeds', unit: 'kg', pricePaise: 25000, gstRatePct: 5, stockQty: 50 })).body.data;
    contact = (await post('/contacts', { name: 'Ravi Traders', phone: '9829012345', state: 'Rajasthan' })).body.data;
    lead = (await post('/leads', { contactId: contact.id, title: 'Cumin' })).body.data;
    quotation = (await post('/quotations', { leadId: lead.id, items: [{ productId: product.id, quantity: 20 }] })).body.data;
  });
  beforeEach(() => {
    sent = [];
    jest.spyOn(mock, 'sendMessage').mockImplementation(async (credentials, body) => {
      sent.push(body);
      wamids += 1;
      return { providerMessageId: `wamid.ORDER${wamids}` };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('is made once from an accepted quotation, copying its lines and totals', async () => {
    expect((await post('/orders', { quotationId: quotation.id })).body.code).toBe('NOT_ACCEPTED');
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(auth()).send({ status: 'Sent' });
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(auth()).send({ status: 'Accepted' });
    const res = await post('/orders', { quotationId: quotation.id });
    expect(res.status).toBe(201);
    order = res.body.data;
    expect(order.number).toMatch(/^SO\/\d{4}-\d{2}\/0001$/);
    expect(order).toMatchObject({
      stage: 'Received', quotationNumber: quotation.number, leadId: lead.id, contactId: contact.id,
      billTo: { name: 'Ravi Traders' }, totals: { grandTotalPaise: 525000 }, nextStages: ['Processing', 'Dispatched', 'Delivered', 'Payment Collected', 'Cancelled'],
    });
    expect(order.items[0]).toMatchObject({ name: 'Cumin Seeds', quantity: 20, cgstPaise: 12500 });
    expect(order.history).toEqual([expect.objectContaining({ stage: 'Received', byName: 'Asha', note: `From quotation ${quotation.number}` })]);
    expect(String((await Quotation.findById(quotation.id)).orderId)).toBe(order.id);
    expect((await post('/orders', { quotationId: quotation.id })).body.code).toBe('ORDER_EXISTS');
    // The quotation is now tied to the order.
    expect((await api().patch(`/api/v1/quotations/${quotation.id}`).set(auth()).send({ status: 'Sent' })).body.code).toBe('HAS_ORDER');
    expect((await api().delete(`/api/v1/quotations/${quotation.id}`).set(auth())).status).toBe(409);
    expect(await LeadActivity.exists({ leadId: lead.id, text: new RegExp(`^Order ${order.number.replace(/\//g, '\\/')} received`) })).toBeTruthy();
    expect((await api().get('/api/v1/orders/summary').set(auth())).body.data).toMatchObject({ total: 1, counts: { Received: 1, Dispatched: 0 } });
  });

  it('moves through the stages with dispatch details; stock goes down once on dispatch and back if undone', async () => {
    expect((await stage(order.id, { stage: 'Processing' })).body.data.stage).toBe('Processing');
    expect(await stock()).toBe(50);
    const dispatched = (await stage(order.id, { stage: 'Dispatched', dispatch: { transporter: 'VRL Logistics', lrNumber: 'LR-88213' } })).body.data;
    expect(dispatched).toMatchObject({ stage: 'Dispatched', stockReduced: true, dispatch: { transporter: 'VRL Logistics', lrNumber: 'LR-88213' } });
    expect(dispatched.dispatch.dispatchedAt).toBeTruthy();
    expect(await stock()).toBe(30);
    expect(await LeadActivity.exists({ leadId: lead.id, text: /Processing → Dispatched \(VRL Logistics, LR LR-88213\)$/ })).toBeTruthy();

    // A mistake: back to Processing puts the stock back; dispatching again takes it once.
    await stage(order.id, { stage: 'Processing', note: 'Wrong truck' });
    expect(await stock()).toBe(50);
    await stage(order.id, { stage: 'Dispatched' });
    await stage(order.id, { stage: 'Delivered' });
    expect(await stock()).toBe(30);
    expect((await stage(order.id, { stage: 'Delivered' })).body.code).toBe('SAME_STAGE');
    const history = (await api().get(`/api/v1/orders/${order.id}`).set(auth())).body.data.history;
    expect(history.map((h) => h.stage)).toEqual(['Received', 'Processing', 'Dispatched', 'Processing', 'Dispatched', 'Delivered']);
    expect(history[3]).toMatchObject({ from: 'Dispatched', note: 'Wrong truck' });
  });

  it('payment collected wins the lead; a paid order cannot be cancelled', async () => {
    const paid = (await stage(order.id, { stage: 'Payment Collected' })).body.data;
    expect(paid.paidAt).toBeTruthy();
    expect(paid.nextStages).not.toContain('Cancelled');
    expect((await Lead.findById(lead.id)).stage).toBe('Won');
    expect((await Contact.findById(contact.id)).lifecycle).toBe('customer');
    expect((await stage(order.id, { stage: 'Cancelled', cancelReason: 'x' })).body.code).toBe('ORDER_PAID');
  });

  it('cancelling needs a reason, gives the stock back (never below zero), and is final', async () => {
    await Product.updateOne({ _id: product.id }, { stockQty: 5 });
    const q2 = (await post('/quotations', { contactId: contact.id, items: [{ productId: product.id, quantity: 20 }] })).body.data;
    await api().patch(`/api/v1/quotations/${q2.id}`).set(auth()).send({ status: 'Accepted' });
    const o2 = (await post('/orders', { quotationId: q2.id })).body.data;
    expect(o2.number).toMatch(/0002$/);
    await stage(o2.id, { stage: 'Dispatched' });
    expect(await stock()).toBe(0);
    expect((await Order.findById(o2.id)).stockMoves.map((m) => m.quantity)).toEqual([5]);
    expect((await stage(o2.id, { stage: 'Cancelled' })).body.code).toBe('CANCEL_REASON_REQUIRED');
    const cancelled = (await stage(o2.id, { stage: 'Cancelled', cancelReason: 'Customer changed the order' })).body.data;
    expect(cancelled).toMatchObject({ stage: 'Cancelled', cancelReason: 'Customer changed the order', stockReduced: false, nextStages: [] });
    expect(await stock()).toBe(5);
    expect((await stage(o2.id, { stage: 'Received' })).body.code).toBe('ORDER_CANCELLED');
  });

  it('sends the customer a WhatsApp update: a text in the window, else a template with suggested values', async () => {
    const o3q = (await post('/quotations', { contactId: contact.id, items: [{ name: 'Packing', quantity: 1, unitPricePaise: 5000 }] })).body.data;
    await api().patch(`/api/v1/quotations/${o3q.id}`).set(auth()).send({ status: 'Accepted' });
    const o3 = (await post('/orders', { quotationId: o3q.id })).body.data;
    await stage(o3.id, { stage: 'Dispatched', dispatch: { transporter: 'Delhivery', lrNumber: 'AWB 1234' } });
    const options = (await api().get(`/api/v1/orders/${o3.id}/notify-options`).set(auth())).body.data;
    expect(options).toMatchObject({ blocked: '', windowOpen: false });
    expect(options.text).toBe(`Namaste Ravi Traders, your order ${o3.number} has been dispatched by Delhivery (LR no. AWB 1234).`);
    const orderUpdate = options.templates.find((t) => t.name === 'order_update');
    expect(orderUpdate.suggested.body).toEqual({ 1: 'Ravi Traders', 2: o3.number });
    expect(options.templates.map((t) => t.name)).not.toContain('quotation_pdf'); // needs a PDF

    expect((await post(`/orders/${o3.id}/notify`, { mode: 'text', text: 'Hi' })).body.code).toBe('WINDOW_CLOSED');
    const res = await post(`/orders/${o3.id}/notify`, { mode: 'template', templateId: templates.order_update.id, variables: { body: orderUpdate.suggested.body } });
    expect(res.status).toBe(200);
    expect(sent[0]).toMatchObject({ type: 'template', template: { name: 'order_update', components: [{ type: 'body', parameters: [{ text: 'Ravi Traders' }, { text: o3.number }] }] } });
    expect(res.body.data.order.history.at(-1)).toMatchObject({ stage: 'Dispatched', notified: true });

    await post('/dev/simulate/whatsapp-inbound', { from: '9829012345', name: 'Ravi Traders', text: 'When will it arrive?' });
    const text = await post(`/orders/${o3.id}/notify`, { mode: 'text', text: 'Arriving tomorrow.' });
    expect(text.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ type: 'text', text: { body: 'Arriving tomorrow.' } });
  });

  it('lists with filters; agents see their own orders; other companies none', async () => {
    const byLr = (await api().get('/api/v1/orders?q=AWB').set(auth())).body.data;
    expect(byLr).toHaveLength(1);
    expect((await api().get('/api/v1/orders?stage=Cancelled').set(auth())).body.data).toHaveLength(1);
    const agent = await inviteAndJoin(owner.token, 'order-agent@example.com', { role: 'agent' });
    expect((await api().get('/api/v1/orders').set(bearer(agent.token))).body.data).toEqual([]);
    const stranger = await login('order-stranger@example.com');
    expect((await api().get(`/api/v1/orders/${order.id}`).set(bearer(stranger.token))).status).toBe(404);
    expect((await post(`/orders/${order.id}/stage`, { stage: 'Received' }, stranger.token)).status).toBe(404);
    expect((await post('/orders', { quotationId: quotation.id }, stranger.token)).status).toBe(404);
  });
});

describe('Quote Sent, no reply for N days', () => {
  it('lists leads whose sent quotation has waited N days without a WhatsApp reply', async () => {
    const owner = await login('wait-owner@example.com');
    const auth = bearer(owner.token);
    await api().post('/api/v1/whatsapp/accounts').set(auth).send({ provider: 'mock' });
    const make = async (name, phone, daysAgo) => {
      const contact = (await api().post('/api/v1/contacts').set(auth).send({ name, phone })).body.data;
      const lead = (await api().post('/api/v1/leads').set(auth).send({ contactId: contact.id, title: name })).body.data;
      const q = (await api().post('/api/v1/quotations').set(auth).send({ leadId: lead.id, items: [{ name: 'Item', quantity: 1, unitPricePaise: 10000 }] })).body.data;
      await api().patch(`/api/v1/quotations/${q.id}`).set(auth).send({ status: 'Sent' });
      await Quotation.updateOne({ _id: q.id }, { sentAt: new Date(Date.now() - daysAgo * 86400000) });
      return { contact, lead, q };
    };
    const silent = await make('Silent Buyer', '9000000101', 5);
    const replied = await make('Replying Buyer', '9000000102', 5);
    const recent = await make('Recent Buyer', '9000000103', 1);
    await api().post('/api/v1/dev/simulate/whatsapp-inbound').set(auth).send({ from: '9000000102', name: 'Replying Buyer', text: 'Let me think' });

    const rows = (await api().get('/api/v1/quotations/awaiting-reply?days=3').set(auth)).body.data;
    expect(rows.map((r) => r.lead.id)).toEqual([silent.lead.id]);
    expect(rows[0]).toMatchObject({ waitingDays: 5, quotation: { number: silent.q.number, status: 'Sent', viewCount: 0 }, lead: { stage: 'Quote Sent', contact: { name: 'Silent Buyer' } } });
    expect((await api().get('/api/v1/quotations/awaiting-reply?days=7').set(auth)).body.data).toEqual([]);
    expect(replied && recent).toBeTruthy();

    // Accepted, or moved on to Negotiation: no longer waiting.
    await api().patch(`/api/v1/leads/${silent.lead.id}`).set(auth).send({ stage: 'Negotiation' });
    expect((await api().get('/api/v1/quotations/awaiting-reply?days=3').set(auth)).body.data).toEqual([]);
  });
});
