jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mock = require('../integrations/whatsapp/mock');
const Counter = require('../models/Counter');
const LeadActivity = require('../models/LeadActivity');
const Order = require('../models/Order');
const PaymentReceipt = require('../models/PaymentReceipt');
const TaxInvoice = require('../models/TaxInvoice');
const { financialYear } = require('../utils/money');
const { creditLine } = require('../services/invoiceService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// D101: GST tax invoices from orders (CGST Rule 46), credit notes (Rule 53(1A)) that take back
// all or part of them, a receipt for every payment, numbers without gaps per financial year,
// "invoice on dispatch", the PDFs, sending them on WhatsApp and invoiced vs collected.
const FY = financialYear().slice(2); // 26-27
const pdfOf = (req) => req.buffer(true).parse((r, cb) => {
  const chunks = [];
  r.on('data', (c) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
});

describe('Tax invoices, credit notes and receipts', () => {
  let owner;
  let agent;
  let templates;
  let cumin;
  let ravi;
  let order;
  let invoice;
  let sent = [];
  let wamids = 0;
  const auth = () => bearer(owner.token);
  const post = (path, body = {}, token = owner.token) => api().post(`/api/v1${path}`).set(bearer(token)).send(body);
  const get = (path, token = owner.token) => api().get(`/api/v1${path}`).set(bearer(token));
  const docsOf = async (orderId) => (await get(`/orders/${orderId}/invoices`)).body.data;

  // An accepted quotation for the contact, and its order.
  async function orderFor(contactId, items) {
    const quotation = (await post('/quotations', { contactId, items })).body.data;
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(auth()).send({ status: 'Sent' });
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(auth()).send({ status: 'Accepted' });
    return (await post('/orders', { quotationId: quotation.id })).body.data;
  }

  beforeAll(async () => {
    owner = await login('invoice-owner@example.com', { name: 'Asha' });
    await api().patch('/api/v1/organization').set(auth()).send({ name: 'Yellow Traders', gstin: '08AAACY1234C1Z5', address: '12 MI Road', city: 'Jaipur', postalCode: '302001' });
    await api().put('/api/v1/organization/billing').set(auth()).send({ upiId: 'yellow@okaxis', bank: { accountName: 'Yellow Traders', accountNumber: '123456789012', ifsc: 'SBIN0001234' } });
    await post('/whatsapp/accounts', { provider: 'mock' });
    templates = Object.fromEntries((await post('/templates/sync')).body.data.map((t) => [t.name, t]));
    agent = await inviteAndJoin(owner.token, 'invoice-agent@example.com', { role: 'agent', modules: ['leads', 'inbox'], permissions: ['leads:view_all'] });
    cumin = (await post('/products', { name: 'Cumin Seeds', unit: 'kg', pricePaise: 25000, gstRatePct: 5, hsnSac: '0909' })).body.data;
    ravi = (await post('/contacts', { name: 'Ravi Traders', phone: '9829012345', state: 'Rajasthan', address: '4 Johari Bazar', city: 'Jaipur' })).body.data;
    await post('/leads', { contactId: ravi.id, title: 'Cumin' });
  });
  beforeEach(() => {
    sent = [];
    jest.spyOn(mock, 'sendMessage').mockImplementation(async (credentials, body) => {
      sent.push(body);
      wamids += 1;
      return { providerMessageId: `wamid.INVOICE${wamids}` };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('makes the tax invoice of an order once: CGST + SGST within the state, numbered INV/<year>/0001', async () => {
    order = await orderFor(ravi.id, [{ productId: cumin.id, quantity: 20 }]);
    expect(await docsOf(order.id)).toEqual({ invoices: [], receipts: [], canInvoice: true, invoiceOnDispatch: false, sellerReady: true });
    const res = await post(`/orders/${order.id}/invoice`);
    expect(res.status).toBe(201);
    invoice = res.body.data.invoice;
    expect(invoice).toMatchObject({
      kind: 'invoice', number: `INV/${FY}/0001`, status: 'issued', orderNumber: order.number, creditedPaise: 0,
      seller: { name: 'Yellow Traders', gstin: '08AAACY1234C1Z5', address: '12 MI Road', stateCode: '08' },
      billTo: { name: 'Ravi Traders', stateCode: '08' },
      supply: { placeOfSupplyCode: '08', interState: false, placeOfSupply: 'Rajasthan' },
      totals: { taxablePaise: 500000, cgstPaise: 12500, sgstPaise: 12500, igstPaise: 0, roundOffPaise: 0, grandTotalPaise: 525000 },
      remaining: [{ quantity: 20, taxablePaise: 500000, cgstPaise: 12500, sgstPaise: 12500, igstPaise: 0 }],
    });
    expect(invoice.number.length).toBeLessThanOrEqual(16);
    expect(invoice.items[0]).toMatchObject({ name: 'Cumin Seeds', hsnSac: '0909', quantity: 20, unit: 'kg', cgstPaise: 12500 });
    expect(res.body.data.warnings).toEqual([]);
    expect(await LeadActivity.exists({ text: new RegExp(`^Tax invoice ${invoice.number.replace(/\//g, '\\/')} made for order`) })).toBeTruthy();

    // Never a second live invoice for the order.
    const again = await post(`/orders/${order.id}/invoice`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVOICE_EXISTS');
    expect((await docsOf(order.id)).canInvoice).toBe(false);
  });

  it('gives the PDF titled "Tax invoice", with the fonts and the UPI QR for what is due', async () => {
    const res = await pdfOf(get(`/invoices/${invoice.id}/pdf`));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="INV-${FY}-0001.pdf"`);
    const text = res.body.toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toContain(`(Tax invoice INV/${FY}/0001)`);
    expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans-Bold/);
    expect((text.match(/\/Subtype \/Image/g) || []).length).toBeGreaterThanOrEqual(1); // the UPI QR (no logo here)
    const stranger = await login('invoice-stranger@example.com');
    expect((await get(`/invoices/${invoice.id}/pdf`, stranger.token)).status).toBe(404);
  });

  it('charges IGST between states and rounds the total, as the order did', async () => {
    const delhi = (await post('/contacts', { name: 'Gupta Steel', phone: '9810012345', gstin: '07AABCG1234A1Z5', address: 'Karol Bagh', city: 'Delhi' })).body.data;
    const bowls = await orderFor(delhi.id, [{ name: 'Steel bowl', hsnSac: '7323', unit: 'pcs', quantity: 3, unitPricePaise: 33333, gstRatePct: 18 }]);
    const made = (await post(`/orders/${bowls.id}/invoice`)).body.data.invoice;
    expect(made.number).toBe(`INV/${FY}/0002`);
    expect(made.supply).toMatchObject({ placeOfSupplyCode: '07', interState: true });
    expect(made.totals).toMatchObject({ taxablePaise: 99999, igstPaise: 18000, cgstPaise: 0, sgstPaise: 0, roundOffPaise: 1, grandTotalPaise: 118000 });
    expect(made.totals).toEqual(expect.objectContaining({ grandTotalPaise: bowls.totals.grandTotalPaise }));

    // One bowl back, then the rest: the last credit note takes the invoice's round-off too.
    const one = (await post(`/invoices/${made.id}/credit-notes`, { lines: [{ index: 0, quantity: 1 }], reason: 'One bowl dented' })).body.data;
    expect(one.creditNote).toMatchObject({ kind: 'credit_note', number: `CN/${FY}/0001`, invoiceNumber: made.number, full: false, totals: { taxablePaise: 33333, igstPaise: 6000, roundOffPaise: 0, grandTotalPaise: 39333 } });
    expect(one.creditNote.items[0]).toMatchObject({ lineIndex: 0, quantity: 1, unitPricePaise: 33333, igstPaise: 6000 });
    expect(one.invoice.remaining[0]).toMatchObject({ quantity: 2, taxablePaise: 66666, igstPaise: 12000 });
    const rest = (await post(`/invoices/${made.id}/credit-notes`, { full: true, reason: 'Order returned' })).body.data;
    expect(rest.creditNote).toMatchObject({ full: true, totals: { taxablePaise: 66666, igstPaise: 12000, roundOffPaise: 1, grandTotalPaise: 78667 } });
    expect(rest.invoice).toMatchObject({ status: 'credited', creditedPaise: 118000 });
    expect(one.creditNote.totals.grandTotalPaise + rest.creditNote.totals.grandTotalPaise).toBe(made.totals.grandTotalPaise);
  });

  it('takes back part of an invoice by quantity or by amount, never more than is left; then all of it', async () => {
    const forbidden = await post(`/invoices/${invoice.id}/credit-notes`, { full: true, reason: 'Returned' }, agent.token);
    expect(forbidden.status).toBe(403); // credit notes are for owners and admins

    const five = (await post(`/invoices/${invoice.id}/credit-notes`, { lines: [{ index: 0, quantity: 5 }], reason: '5 kg came back damp' })).body.data;
    expect(five.creditNote).toMatchObject({ number: `CN/${FY}/0003`, totals: { taxablePaise: 125000, cgstPaise: 3125, sgstPaise: 3125, grandTotalPaise: 131250 }, reason: '5 kg came back damp' });
    expect(five.invoice).toMatchObject({ status: 'issued', creditedPaise: 131250, remaining: [{ quantity: 15, taxablePaise: 375000, cgstPaise: 9375, sgstPaise: 9375 }] });
    // What the customer owes on the order follows the credit notes.
    expect((await get(`/orders/${order.id}`)).body.data).toMatchObject({ billedPaise: 393750, duePaise: 393750, paymentStatus: 'unpaid' });

    const price = (await post(`/invoices/${invoice.id}/credit-notes`, { lines: [{ index: 0, taxablePaise: 100000 }], reason: 'Rate lowered by agreement' })).body.data;
    expect(price.creditNote.totals).toMatchObject({ taxablePaise: 100000, cgstPaise: 2500, sgstPaise: 2500, grandTotalPaise: 105000 });
    expect(price.creditNote.items[0]).toMatchObject({ quantity: 0, unitPricePaise: 0 });
    expect(price.invoice.remaining[0]).toMatchObject({ quantity: 15, taxablePaise: 275000 });

    const tooMany = await post(`/invoices/${invoice.id}/credit-notes`, { lines: [{ index: 0, quantity: 16 }], reason: 'Too many' });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.message).toMatch(/only 15 kg left/);
    expect((await post(`/invoices/${invoice.id}/credit-notes`, { lines: [{ index: 0, taxablePaise: 275001 }], reason: 'Too much' })).status).toBe(400);
    expect((await post(`/invoices/${invoice.id}/credit-notes`, { lines: [{ index: 3, quantity: 1 }], reason: 'No such line' })).status).toBe(400);
    expect((await post(`/invoices/${invoice.id}/credit-notes`, { lines: [{ index: 0, quantity: 1 }] })).status).toBe(400); // a reason is needed

    const all = (await post(`/invoices/${invoice.id}/credit-notes`, { full: true, reason: 'Order cancelled after dispatch' })).body.data;
    expect(all.creditNote.totals).toMatchObject({ taxablePaise: 275000, cgstPaise: 6875, sgstPaise: 6875, grandTotalPaise: 288750 });
    expect(all.invoice).toMatchObject({ status: 'credited', creditedPaise: 525000 });
    expect((await get(`/orders/${order.id}`)).body.data).toMatchObject({ billedPaise: 0, duePaise: 0 });
    expect(five.creditNote.totals.grandTotalPaise + price.creditNote.totals.grandTotalPaise + all.creditNote.totals.grandTotalPaise).toBe(525000);
    expect((await post(`/invoices/${invoice.id}/credit-notes`, { full: true, reason: 'Again' })).body.code).toBe('ALREADY_CREDITED');

    // The credit note's PDF; and once credited in full, the order can be invoiced again.
    const pdf = await pdfOf(get(`/invoices/${all.creditNote.id}/pdf`));
    expect(pdf.body.toString('latin1')).toContain(`(Credit note ${all.creditNote.number})`);
    const docs = await docsOf(order.id);
    expect(docs.canInvoice).toBe(true);
    expect(docs.invoices[0].creditNotes.map((c) => c.number)).toEqual([`CN/${FY}/0003`, `CN/${FY}/0004`, `CN/${FY}/0005`]);
    invoice = (await post(`/orders/${order.id}/invoice`)).body.data.invoice;
    expect(invoice.number).toBe(`INV/${FY}/0003`);
    expect((await get(`/orders/${order.id}`)).body.data).toMatchObject({ billedPaise: 525000, duePaise: 525000 });
  });

  it('asks for the address of a customer without GSTIN from ₹50,000; a corrected state moves the place of supply', async () => {
    const walkIn = (await post('/contacts', { name: 'Walk-in Buyer', phone: '9820012345' })).body.data;
    const big = await orderFor(walkIn.id, [{ name: 'Office chairs', quantity: 1, unitPricePaise: 6000000, gstRatePct: 18 }]);
    expect(big.supply).toMatchObject({ placeOfSupplyCode: '08', interState: false, stateAssumed: true });
    const refused = await post(`/orders/${big.id}/invoice`);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('BUYER_ADDRESS_REQUIRED');
    const res = await post(`/orders/${big.id}/invoice`, { billTo: { address: '5 Marine Drive', city: 'Mumbai', state: 'Maharashtra', postalCode: '400002' } });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice).toMatchObject({
      billTo: { name: 'Walk-in Buyer', address: '5 Marine Drive', state: 'Maharashtra', stateCode: '27' },
      supply: { placeOfSupplyCode: '27', interState: true, stateAssumed: false },
      totals: { taxablePaise: 6000000, igstPaise: 1080000, cgstPaise: 0, grandTotalPaise: 7080000 },
    });
    expect(res.body.data.warnings).toEqual([]);
    // The order itself is not changed by the invoice.
    expect((await Order.findById(big.id)).billTo.address).toBe('');
  });

  it('needs the seller\'s GSTIN and address first (from the order and from a quotation)', async () => {
    await api().patch('/api/v1/organization').set(auth()).send({ gstin: '' });
    const small = await orderFor(ravi.id, [{ productId: cumin.id, quantity: 1 }]);
    expect((await docsOf(small.id)).sellerReady).toBe(false);
    expect((await post(`/orders/${small.id}/invoice`)).body.code).toBe('SELLER_GSTIN_REQUIRED');
    const quotation = (await post('/quotations', { contactId: ravi.id, items: [{ productId: cumin.id, quantity: 1 }] })).body.data;
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(auth()).send({ status: 'Sent' });
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(auth()).send({ status: 'Accepted' });
    expect((await post(`/quotations/${quotation.id}/invoice`)).body.code).toBe('SELLER_GSTIN_REQUIRED');
    expect(await Order.exists({ quotationId: quotation.id })).toBeFalsy(); // no order made for nothing
    await api().patch('/api/v1/organization').set(auth()).send({ gstin: '08AAACY1234C1Z5' });

    // An accepted quotation: its order and invoice in one go.
    const res = await post(`/quotations/${quotation.id}/invoice`);
    expect(res.status).toBe(201);
    expect(res.body.data.invoice.orderId).toBe(String(res.body.data.orderId));
    expect(await Order.exists({ _id: res.body.data.orderId, quotationId: quotation.id })).toBeTruthy();
  });

  it('gives every payment a numbered receipt; a removed payment leaves its receipt cancelled', async () => {
    const paid = await post(`/orders/${order.id}/payments`, { amountPaise: 200000, method: 'bank_transfer', reference: 'UTR11' });
    expect(paid.status).toBe(201);
    let docs = await docsOf(order.id);
    expect(docs.receipts).toEqual([expect.objectContaining({
      number: `RCPT/${FY}/0001`, amountPaise: 200000, method: 'bank_transfer', reference: 'UTR11', invoiceNumber: invoice.number, status: 'issued',
      paymentId: paid.body.data.payments[0].id, receivedFrom: expect.objectContaining({ name: 'Ravi Traders' }),
    })]);
    const pdf = await pdfOf(get(`/receipts/${docs.receipts[0].id}/pdf`));
    expect(pdf.status).toBe(200);
    expect(pdf.body.toString('latin1')).toContain(`(Receipt RCPT/${FY}/0001)`);
    expect(pdf.headers['content-disposition']).toBe(`attachment; filename="RCPT-${FY}-0001.pdf"`);

    // Removed by mistake: the receipt stays, cancelled; the next payment takes the next number.
    await api().delete(`/api/v1/orders/${order.id}/payments/${paid.body.data.payments[0].id}`).set(auth());
    const second = await post(`/orders/${order.id}/payments`, { amountPaise: 150000, method: 'cash' });
    docs = await docsOf(order.id);
    expect(docs.receipts.map((r) => [r.number, r.status])).toEqual([[`RCPT/${FY}/0001`, 'cancelled'], [`RCPT/${FY}/0002`, 'issued']]);
    expect((await get('/orders/dues')).body.data.items.find((d) => d.id === order.id)).toMatchObject({ amountPaidPaise: 150000, duePaise: 375000 });

    // A payment from before receipts existed gets one on asking (once).
    const paymentId = second.body.data.payments[0].id;
    await PaymentReceipt.deleteOne({ paymentId });
    const made = await post(`/orders/${order.id}/payments/${paymentId}/receipt`);
    expect(made.body.data).toMatchObject({ number: `RCPT/${FY}/0003`, amountPaise: 150000 });
    expect((await post(`/orders/${order.id}/payments/${paymentId}/receipt`)).body.data.number).toBe(`RCPT/${FY}/0003`);

    // The invoice's PDF shows what was paid.
    const invoicePdf = await pdfOf(get(`/invoices/${invoice.id}/pdf`));
    expect(invoicePdf.status).toBe(200);
  });

  it('makes the invoice by itself when an order is dispatched, if Settings → Billing says so', async () => {
    const billing = await api().put('/api/v1/organization/billing').set(auth()).send({ invoiceOnDispatch: true });
    expect(billing.body.data.invoiceOnDispatch).toBe(true);
    const next = await orderFor(ravi.id, [{ productId: cumin.id, quantity: 2 }]);
    const moved = (await post(`/orders/${next.id}/stage`, { stage: 'Dispatched' })).body.data;
    expect(moved.stage).toBe('Dispatched');
    expect(moved.invoiceMade.number).toMatch(new RegExp(`^INV/${FY}/\\d{4}$`));
    expect(moved.billedPaise).toBe(next.totals.grandTotalPaise); // the order as the invoice left it
    expect(await TaxInvoice.findById(moved.invoiceMade.id).lean()).toMatchObject({ auto: true, status: 'issued' });
    // Back and forth: no second invoice.
    await post(`/orders/${next.id}/stage`, { stage: 'Processing' });
    const again = (await post(`/orders/${next.id}/stage`, { stage: 'Dispatched' })).body.data;
    expect(again.invoiceMade).toBeUndefined();
    expect(await TaxInvoice.countDocuments({ orderId: next.id })).toBe(1);

    // Without the seller's GSTIN the move stands and says why there is no invoice.
    await api().patch('/api/v1/organization').set(auth()).send({ gstin: '' });
    const third = await orderFor(ravi.id, [{ productId: cumin.id, quantity: 1 }]);
    const shipped = (await post(`/orders/${third.id}/stage`, { stage: 'Dispatched' })).body.data;
    expect(shipped.stage).toBe('Dispatched');
    expect(shipped.invoiceError).toMatch(/GSTIN/);
    await api().patch('/api/v1/organization').set(auth()).send({ gstin: '08AAACY1234C1Z5' });
    await api().put('/api/v1/organization/billing').set(auth()).send({ invoiceOnDispatch: false });
  });

  it('numbers without gaps, with the prefix from Settings (at most 4 characters, 16 in all)', async () => {
    expect((await api().put('/api/v1/organization/billing').set(auth()).send({ prefixes: { invoice: 'BILLS' } })).status).toBe(400);
    expect((await api().put('/api/v1/organization/billing').set(auth()).send({ prefixes: { invoice: 'CN' } })).status).toBe(400); // the credit notes' own
    expect((await api().put('/api/v1/organization/billing').set(auth()).send({ prefixes: { invoice: 'bill' } })).body.data.prefixes.invoice).toBe('BILL');
    const orders = [];
    for (let i = 0; i < 4; i += 1) orders.push(await orderFor(ravi.id, [{ productId: cumin.id, quantity: i + 1 }]));
    const before = await TaxInvoice.countDocuments({ kind: 'invoice' });
    const made = await Promise.all(orders.map((o) => post(`/orders/${o.id}/invoice`)));
    expect(made.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const numbers = made.map((r) => Number(r.body.data.invoice.number.split('/')[2])).sort((a, b) => a - b);
    expect(numbers).toEqual([before + 1, before + 2, before + 3, before + 4]);
    expect(made.every((r) => r.body.data.invoice.number.startsWith(`BILL/${FY}/`))).toBe(true);

    // A number may not pass 16 characters: BILL/26-27/100000 is refused.
    const last = await orderFor(ravi.id, [{ productId: cumin.id, quantity: 1 }]);
    await Counter.updateOne({ name: `invoice:${financialYear()}` }, { $set: { seq: 99999 } });
    const full = await post(`/orders/${last.id}/invoice`);
    expect(full.status).toBe(409);
    expect(full.body.code).toBe('NUMBERS_FULL');
    expect(await TaxInvoice.exists({ orderId: last.id })).toBeFalsy();
    await Counter.updateOne({ name: `invoice:${financialYear()}` }, { $set: { seq: before + 4 } });
  });

  it('sends an invoice or a receipt in the WhatsApp chat: a PDF template outside the window, a document inside', async () => {
    const options = (await get(`/invoices/${invoice.id}/send-options`)).body.data;
    expect(options).toMatchObject({ blocked: '', phone: '+919829012345' });
    expect(options.caption).toBe(`Namaste Ravi Traders, please find our tax invoice ${invoice.number} for ₹5,250.00.`);
    const pdfTemplate = options.templates.find((t) => t.name === 'quotation_pdf');
    expect(pdfTemplate.suggested.body).toEqual({ 1: 'Ravi Traders', 2: invoice.number, 3: '₹5,250.00' });

    expect((await post(`/invoices/${invoice.id}/send`, { mode: 'document', caption: 'Hi' })).body.code).toBe('WINDOW_CLOSED');
    const res = await post(`/invoices/${invoice.id}/send`, { mode: 'template', templateId: templates.quotation_pdf.id, variables: { body: pdfTemplate.suggested.body } });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatchObject({ type: 'template', media: { mimeType: 'application/pdf', fileName: `INV-${FY}-0003.pdf` } });
    expect(sent[0].template.components[0].parameters[0]).toMatchObject({ type: 'document', document: { filename: `INV-${FY}-0003.pdf` } });
    expect((await TaxInvoice.findById(invoice.id)).sentAt).toBeTruthy();

    await post('/dev/simulate/whatsapp-inbound', { from: '9829012345', name: 'Ravi Traders', text: 'Receipt please' });
    const receipt = (await docsOf(order.id)).receipts.find((r) => r.status === 'issued');
    const doc = await post(`/receipts/${receipt.id}/send`, { mode: 'document', caption: 'Your receipt' });
    expect(doc.status).toBe(200);
    expect(sent[1]).toMatchObject({ type: 'document', document: { caption: 'Your receipt', filename: `${receipt.number.replace(/\//g, '-')}.pdf` } });

    // Without the inbox a teammate cannot send it.
    const leadsOnly = await inviteAndJoin(owner.token, 'invoice-leads@example.com', { role: 'agent', modules: ['leads'], permissions: ['leads:view_all'] });
    expect((await get(`/invoices/${invoice.id}/send-options`, leadsOnly.token)).status).toBe(403);
    expect((await get(`/invoices/${invoice.id}/pdf`, leadsOnly.token)).status).toBe(200);
  });

  it('reports what was invoiced (less credit notes) next to what was collected', async () => {
    const all = await TaxInvoice.find({}).lean();
    const net = all.reduce((sum, d) => sum + (d.kind === 'credit_note' ? -1 : 1) * d.totals.grandTotalPaise, 0);
    const p = (await get('/reports/payments')).body.data;
    expect(p.invoiced).toMatchObject({
      amountPaise: net,
      invoices: all.filter((d) => d.kind === 'invoice').length,
      creditNotes: all.filter((d) => d.kind === 'credit_note').length,
    });
    expect(p.trend.reduce((sum, r) => sum + r.invoicedPaise, 0)).toBe(net);
    expect(p.collected.amountPaise).toBe(150000);
  });
});

// The credit note's money for one line, without the database.
describe('Credit note lines', () => {
  const line = { name: 'Bowl', quantity: 3, taxablePaise: 99999, gstRatePct: 18, cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0 };
  const left = { quantity: 3, taxablePaise: 99999, cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0 };

  it('splits the tax like the invoice and takes the exact rest last', () => {
    const intra = { interState: false, zeroRated: false };
    expect(creditLine(line, left, intra, { quantity: 1 })).toMatchObject({ quantity: 1, taxablePaise: 33333, cgstPaise: 3000, sgstPaise: 3000, totalPaise: 39333 });
    expect(creditLine(line, left, intra, { quantity: 3 })).toMatchObject({ taxablePaise: 99999, cgstPaise: 9000, sgstPaise: 9000 });
    expect(creditLine(line, left, intra, { taxablePaise: 50 })).toMatchObject({ quantity: 0, taxablePaise: 50, cgstPaise: 5, sgstPaise: 5 });
    const igst = { cgstPaise: 0, sgstPaise: 0, igstPaise: 18000 };
    expect(creditLine({ ...line, ...igst }, { ...left, ...igst }, { interState: true }, { quantity: 1.5 })).toMatchObject({ quantity: 1.5, taxablePaise: 50000, igstPaise: 9000, cgstPaise: 0, unitPricePaise: 33333 });
    expect(creditLine(line, left, { zeroRated: true }, { quantity: 1 })).toMatchObject({ taxablePaise: 33333, taxPaise: 0 });
  });

  it('refuses more than is left, or nothing', () => {
    const intra = { interState: false };
    expect(creditLine(line, left, intra, { quantity: 4 })).toBeNull();
    expect(creditLine(line, left, intra, { taxablePaise: 100000 })).toBeNull();
    expect(creditLine(line, { ...left, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 }, intra, { quantity: 1 })).toBeNull();
  });
});
