jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const AuditLog = require('../models/AuditLog');
const PaymentReceipt = require('../models/PaymentReceipt');
const { indiaDate } = require('../utils/dates');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Tally (G5, D109): the period's tax invoices, credit notes and receipts as Tally import XML — a
// ledgers file (customers under Sundry Debtors, the sales, GST, round-off, bank and cash ledgers)
// and a vouchers file (Sales, Credit Note, Receipt in accounting voucher view): debits negative
// and deemed positive, credits positive, every voucher balanced, bill-wise against the invoice.
const TODAY = indiaDate(0);
const DAY = TODAY.replace(/-/g, '');
const escapeRe = (name) => name.replace(/\./g, '\\.');
const blocks = (xml, name) => [...xml.matchAll(new RegExp(`<${escapeRe(name)}[ >][\\s\\S]*?</${escapeRe(name)}>`, 'g'))].map((m) => m[0]);
const value = (xml, name) => xml.match(new RegExp(`<${escapeRe(name)}>([^<]*)</${escapeRe(name)}>`))?.[1];
const entriesOf = (voucher) => blocks(voucher, 'LEDGERENTRIES.LIST').map((e) => {
  const bill = blocks(e, 'BILLALLOCATIONS.LIST')[0];
  return {
    ledger: value(e, 'LEDGERNAME'), deemed: value(e, 'ISDEEMEDPOSITIVE'), amount: Number(value(e, 'AMOUNT')),
    ...(bill && { bill: { name: value(bill, 'NAME') || null, type: value(bill, 'BILLTYPE'), amount: Number(value(bill, 'AMOUNT')) } }),
  };
});
const voucherOf = (xml, number) => blocks(xml, 'VOUCHER').find((v) => value(v, 'VOUCHERNUMBER') === number);
const balance = (voucher) => entriesOf(voucher).reduce((sum, e) => sum + Math.round(e.amount * 100), 0); // in paise

// Every tag closed in order, and no bare "&".
function wellFormed(xml) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const stack = [];
  for (const [, close, name, self] of body.matchAll(/<(\/?)([A-Za-z][\w.:]*)(?:\s[^<>]*?)?(\/?)>/g)) {
    if (self) continue;
    if (!close) stack.push(name);
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0 && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(body);
}

describe('Tally export (G5, D109)', () => {
  let owner;
  let agent;
  const auth = () => bearer(owner.token);
  const post = (path, body = {}) => api().post(`/api/v1${path}`).set(auth()).send(body);
  const exportOf = async (part, from = TODAY, to = TODAY) => api().get(`/api/v1/tally/export?from=${from}&to=${to}&part=${part}`).set(auth()).buffer(true).parse((res, cb) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => cb(null, text));
  });
  async function orderFor(contactId, items) {
    const quotation = (await post('/quotations', { contactId, items })).body.data;
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(auth()).send({ status: 'Sent' });
    await api().patch(`/api/v1/quotations/${quotation.id}`).set(auth()).send({ status: 'Accepted' });
    return (await post('/orders', { quotationId: quotation.id })).body.data;
  }
  const invoiceOf = async (order) => (await post(`/orders/${order.id}/invoice`)).body.data.invoice;
  let local;
  let interState;
  let credit;
  let advance;

  beforeAll(async () => {
    owner = await login('tally-owner@example.com', { name: 'Asha' });
    agent = await inviteAndJoin(owner.token, 'tally-agent@example.com');
    await api().patch('/api/v1/organization').set(auth()).send({ name: 'Yellow Traders', gstin: '08AAACY1234C1Z5', address: '12 MI Road', city: 'Jaipur', postalCode: '302001' });
    const cumin = (await post('/products', { name: 'Cumin Seeds', unit: 'kg', pricePaise: 25000, gstRatePct: 5, hsnSac: '0909' })).body.data;
    const bowl = (await post('/products', { name: 'Steel Bowl', unit: 'pc', pricePaise: 9999, gstRatePct: 18, hsnSac: '7323' })).body.data;
    const ravi = (await post('/contacts', { name: 'Ravi Traders', phone: '9829012345', state: 'Rajasthan', address: '4 Johari Bazar', city: 'Jaipur' })).body.data;
    const sharma = (await post('/contacts', { name: 'Rohit Sharma', company: 'Sharma & Sons', phone: '9811012345', gstin: '07AABCS1234D1Z2', state: 'Delhi', address: '7 Chandni Chowk', city: 'Delhi' })).body.data;

    // Within the state (CGST + SGST), paid by UPI after the invoice.
    const first = await orderFor(ravi.id, [{ productId: cumin.id, quantity: 20 }]);
    local = await invoiceOf(first);
    await post(`/orders/${first.id}/payments`, { amountPaise: 200000, method: 'upi', reference: 'UPI-881' });
    // To Delhi (IGST) with two GST rates and a round-off; one bowl comes back (a credit note).
    const second = await orderFor(sharma.id, [{ productId: cumin.id, quantity: 2 }, { productId: bowl.id, quantity: 3 }]);
    interState = await invoiceOf(second);
    credit = (await post(`/invoices/${interState.id}/credit-notes`, { lines: [{ index: 1, quantity: 1 }], reason: 'One bowl dented' })).body.data.creditNote;
    // Cash before any invoice (on account); a payment entered by mistake and removed again.
    const third = await orderFor(ravi.id, [{ productId: cumin.id, quantity: 4 }]);
    await post(`/orders/${third.id}/payments`, { amountPaise: 50000, method: 'cash' });
    advance = await PaymentReceipt.findOne({ orderId: third.id, status: 'issued' }).lean();
    await post(`/orders/${third.id}/payments`, { amountPaise: 1000, method: 'card', reference: 'WRONG' });
    const wrong = await PaymentReceipt.findOne({ orderId: third.id, reference: 'WRONG' }).lean();
    expect((await api().delete(`/api/v1/orders/${third.id}/payments/${wrong.paymentId}`).set(auth())).status).toBe(200);
  });

  it('shows owners and admins the ledger names and what the period holds; others may not', async () => {
    expect((await api().get(`/api/v1/tally?from=${TODAY}&to=${TODAY}`).set(bearer(agent.token))).status).toBe(403);
    expect((await api().get(`/api/v1/tally/export?from=${TODAY}&to=${TODAY}&part=vouchers`).set(bearer(agent.token))).status).toBe(403);
    const res = await api().get(`/api/v1/tally?from=${TODAY}&to=${TODAY}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      ledgers: { sales: 'Sales', cgst: 'Output CGST', sgst: 'Output SGST', igst: 'Output IGST', roundOff: 'Round Off', bank: 'Bank', cash: 'Cash', gateway: 'Bank' },
      splitByRate: false,
      range: { from: TODAY, to: TODAY },
      summary: { invoices: 2, creditNotes: 1, receipts: 2, parties: 2, receiptsPaise: 250000, invoicesPaise: local.totals.grandTotalPaise + interState.totals.grandTotalPaise },
    });
    const backwards = await api().get(`/api/v1/tally/export?from=${TODAY}&to=2020-01-01&part=vouchers`).set(auth());
    expect(backwards.status).toBe(400);
    const tooLong = await api().get(`/api/v1/tally/export?from=2024-01-01&to=${TODAY}&part=vouchers`).set(auth());
    expect(tooLong.body.errors[0].code).toBe('RANGE_TOO_LONG');
  });

  it('writes the vouchers: Sales, Credit Note and Receipt, balanced, debits negative, bill-wise', async () => {
    const res = await exportOf('vouchers');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/xml; charset=utf-8/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="tally-vouchers-${TODAY}-to-${TODAY}.xml"`);
    const xml = res.body;
    expect(wellFormed(xml)).toBe(true);
    expect(value(xml, 'TALLYREQUEST')).toBe('Import Data');
    expect(value(xml, 'REPORTNAME')).toBe('Vouchers');
    const vouchers = blocks(xml, 'VOUCHER');
    expect(vouchers).toHaveLength(5); // 2 invoices, 1 credit note, 2 receipts (the removed payment's is cancelled)
    for (const v of vouchers) {
      expect(balance(v)).toBe(0);
      for (const e of entriesOf(v)) expect(e.deemed).toBe(e.amount < 0 ? 'Yes' : 'No');
      expect(value(v, 'DATE')).toBe(DAY);
      expect(value(v, 'PERSISTEDVIEW')).toBe('Accounting Voucher View');
    }

    const sale = voucherOf(xml, local.number);
    expect(sale).toMatch(new RegExp(`^<VOUCHER REMOTEID="crm-${local.id}" VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">`));
    expect(value(sale, 'PARTYLEDGERNAME')).toBe('Ravi Traders');
    expect(value(sale, 'REFERENCE')).toBe(local.orderNumber);
    expect(entriesOf(sale)).toEqual([
      { ledger: 'Ravi Traders', deemed: 'Yes', amount: -5250, bill: { name: local.number, type: 'New Ref', amount: -5250 } },
      { ledger: 'Sales', deemed: 'No', amount: 5000 },
      { ledger: 'Output CGST', deemed: 'No', amount: 125 },
      { ledger: 'Output SGST', deemed: 'No', amount: 125 },
    ]);

    const igst = voucherOf(xml, interState.number);
    expect(value(igst, 'PARTYLEDGERNAME')).toBe('Sharma &amp; Sons');
    expect(value(igst, 'PARTYGSTIN')).toBe('07AABCS1234D1Z2');
    expect(value(igst, 'PLACEOFSUPPLY')).toBe('Delhi');
    const t = interState.totals;
    expect(entriesOf(igst)).toEqual([
      expect.objectContaining({ ledger: 'Sharma &amp; Sons', amount: -t.grandTotalPaise / 100 }),
      { ledger: 'Sales', deemed: 'No', amount: t.taxablePaise / 100 },
      { ledger: 'Output IGST', deemed: 'No', amount: t.igstPaise / 100 },
      ...(t.roundOffPaise ? [{ ledger: 'Round Off', deemed: t.roundOffPaise < 0 ? 'Yes' : 'No', amount: t.roundOffPaise / 100 }] : []),
    ]);

    const note = voucherOf(xml, credit.number);
    expect(note).toMatch(/^<VOUCHER REMOTEID="crm-[0-9a-f]{24}" VCHTYPE="Credit Note"/);
    expect(value(note, 'NARRATION')).toBe(`Against ${interState.number}: One bowl dented`);
    const [party, ...rest] = entriesOf(note);
    expect(party).toEqual({ ledger: 'Sharma &amp; Sons', deemed: 'No', amount: credit.totals.grandTotalPaise / 100, bill: { name: interState.number, type: 'Agst Ref', amount: credit.totals.grandTotalPaise / 100 } });
    expect(rest.filter((e) => e.ledger !== 'Round Off').every((e) => e.deemed === 'Yes' && e.amount < 0)).toBe(true);

    const upi = blocks(xml, 'VOUCHER').find((v) => value(v, 'VOUCHERTYPENAME') === 'Receipt' && value(v, 'REFERENCE') === 'UPI-881');
    expect(entriesOf(upi)).toEqual([
      { ledger: 'Ravi Traders', deemed: 'No', amount: 2000, bill: { name: local.number, type: 'Agst Ref', amount: 2000 } },
      { ledger: 'Bank', deemed: 'Yes', amount: -2000 },
    ]);
    expect(value(upi, 'NARRATION')).toBe(`Order ${local.orderNumber} · UPI · Ref UPI-881`);
    const cash = voucherOf(xml, advance.number);
    expect(entriesOf(cash)).toEqual([
      { ledger: 'Ravi Traders', deemed: 'No', amount: 500, bill: { name: null, type: 'On Account', amount: 500 } },
      { ledger: 'Cash', deemed: 'Yes', amount: -500 },
    ]);
    expect(xml).not.toContain('WRONG');
    expect(await AuditLog.countDocuments({ organizationId: owner.data.organizationId, action: 'tally.exported' })).toBe(1);
  });

  it('writes the ledgers: customers under Sundry Debtors with GSTIN and state, then the own ledgers', async () => {
    const xml = (await exportOf('ledgers')).body;
    expect(wellFormed(xml)).toBe(true);
    expect(value(xml, 'REPORTNAME')).toBe('All Masters');
    const ledgers = blocks(xml, 'LEDGER');
    const named = (name) => ledgers.find((l) => value(l, 'NAME') === name);
    expect(named('Ravi Traders')).toMatch(/^<LEDGER NAME="Ravi Traders" ACTION="Create">/);
    expect(['PARENT', 'ISBILLWISEON', 'LEDSTATENAME', 'COUNTRYNAME', 'GSTREGISTRATIONTYPE'].map((tag) => value(named('Ravi Traders'), tag)))
      .toEqual(['Sundry Debtors', 'Yes', 'Rajasthan', 'India', 'Unregistered']);
    expect(blocks(named('Ravi Traders'), 'ADDRESS.LIST')[0]).toContain('<ADDRESS>4 Johari Bazar</ADDRESS>');
    const sharma = named('Sharma &amp; Sons');
    expect(['PARENT', 'LEDSTATENAME', 'GSTREGISTRATIONTYPE', 'PARTYGSTIN'].map((tag) => value(sharma, tag)))
      .toEqual(['Sundry Debtors', 'Delhi', 'Regular', '07AABCS1234D1Z2']);
    expect(value(named('Sales'), 'PARENT')).toBe('Sales Accounts');
    expect(['PARENT', 'TAXTYPE', 'GSTDUTYHEAD'].map((tag) => value(named('Output CGST'), tag))).toEqual(['Duties &amp; Taxes', 'GST', 'Central Tax']);
    expect(value(named('Output SGST'), 'GSTDUTYHEAD')).toBe('State Tax');
    expect(value(named('Output IGST'), 'GSTDUTYHEAD')).toBe('Integrated Tax');
    expect(value(named('Bank'), 'PARENT')).toBe('Bank Accounts');
    expect(value(named('Cash'), 'PARENT')).toBe('Cash-in-Hand');
    expect(ledgers.filter((l) => value(l, 'NAME') === 'Bank')).toHaveLength(1); // the bank and the gateway share a name
  });

  it('uses the company\'s own ledger names, and one sales ledger per GST rate when asked', async () => {
    expect((await api().patch('/api/v1/tally').set(auth()).send({ ledgers: { cgst: '' } })).status).toBe(400);
    const saved = await api().patch('/api/v1/tally').set(auth()).send({ splitByRate: true, ledgers: { cgst: 'CGST Payable', bank: 'HDFC Bank' } });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ splitByRate: true, ledgers: { sales: 'Sales', cgst: 'CGST Payable', bank: 'HDFC Bank', gateway: 'Bank' } });
    expect(await AuditLog.countDocuments({ organizationId: owner.data.organizationId, action: 'tally.settings_updated' })).toBe(1);

    const xml = (await exportOf('vouchers')).body;
    expect(entriesOf(voucherOf(xml, local.number)).map((e) => e.ledger)).toEqual(['Ravi Traders', 'Sales 5%', 'CGST Payable', 'Output SGST']);
    const igst = entriesOf(voucherOf(xml, interState.number));
    expect(igst.map((e) => e.ledger).slice(0, 3)).toEqual(['Sharma &amp; Sons', 'Sales 5%', 'Sales 18%']);
    expect(Math.round((igst[1].amount + igst[2].amount) * 100)).toBe(interState.totals.taxablePaise);
    for (const v of blocks(xml, 'VOUCHER')) expect(balance(v)).toBe(0);
    const upi = blocks(xml, 'VOUCHER').find((v) => value(v, 'REFERENCE') === 'UPI-881');
    expect(entriesOf(upi)[1]).toEqual({ ledger: 'HDFC Bank', deemed: 'Yes', amount: -2000 });
    const ledgers = (await exportOf('ledgers')).body;
    expect(blocks(ledgers, 'LEDGER').map((l) => value(l, 'NAME'))).toEqual(expect.arrayContaining(['Sales 5%', 'Sales 18%', 'CGST Payable', 'HDFC Bank']));
  });
});
