const Organization = require('../models/Organization');
const PaymentReceipt = require('../models/PaymentReceipt');
const TaxInvoice = require('../models/TaxInvoice');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { rangeOf } = require('../utils/reportRange');
const { stateName } = require('../constants/gst');

// Tally (G5, D109): the company's tax invoices, credit notes and receipts of a period as Tally
// "Import Data" XML, for TallyPrime and Tally.ERP 9 — first the ledgers file (Import → Masters):
// each customer under Sundry Debtors with its address, state and GSTIN, bill-wise on, and the
// sales, GST, round-off, bank and cash ledgers named in the settings; then the vouchers file
// (Import → Transactions), in accounting voucher view: Sales for an invoice, Credit Note for a
// credit note (against the invoice), Receipt for a receipt (against its invoice, else on account).
// As Tally expects, a debit is a negative amount "deemed positive" and a credit a positive one;
// each voucher balances to the paisa. Dates are days in India (YYYYMMDD). Cancelled receipts stay
// out. Owners and admins; every download is audited.
const DEFAULT_LEDGERS = Object.freeze({
  sales: 'Sales', cgst: 'Output CGST', sgst: 'Output SGST', igst: 'Output IGST', roundOff: 'Round Off', bank: 'Bank', cash: 'Cash', gateway: 'Bank',
});
const LEDGER_KEYS = Object.freeze(Object.keys(DEFAULT_LEDGERS));
const MAX_DAYS = 366;
const MAX_DOCUMENTS = 10000;
const WALK_IN = 'Walk-in Customer';
const METHODS = { cash: 'Cash', bank_transfer: 'Bank transfer', upi: 'UPI', cheque: 'Cheque', card: 'Card', other: 'Other' };

// The company's ledger names (the defaults for what it did not set).
function settingsOf(organization) {
  const saved = organization?.settings?.tally || {};
  const ledgers = Object.fromEntries(LEDGER_KEYS.map((key) => {
    const name = typeof saved.ledgers?.[key] === 'string' ? saved.ledgers[key].trim() : '';
    return [key, name || DEFAULT_LEDGERS[key]];
  }));
  return { ledgers, splitByRate: saved.splitByRate === true };
}

// --- XML ----------------------------------------------------------------------------------------
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g; // not allowed in XML
const esc = (value) => String(value ?? '').replace(CONTROL, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const tag = (name, value) => `<${name}>${esc(value)}</${name}>`;
const amount = (paise) => (paise / 100).toFixed(2);
const yesNo = (flag) => (flag ? 'Yes' : 'No');
const tallyDate = (date) => new Date(new Date(date).getTime() + 330 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
const EOL = '\r\n';

function envelope(report, messages) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE>',
    '<HEADER>', '<TALLYREQUEST>Import Data</TALLYREQUEST>', '</HEADER>',
    '<BODY>', '<IMPORTDATA>',
    '<REQUESTDESC>', tag('REPORTNAME', report), '</REQUESTDESC>',
    '<REQUESTDATA>',
    ...messages.map((message) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${EOL}${message}${EOL}</TALLYMESSAGE>`),
    '</REQUESTDATA>',
    '</IMPORTDATA>', '</BODY>',
    '</ENVELOPE>',
    '',
  ].join(EOL);
}

// The customer's ledger name: the company on the document, else the person.
const partyName = (party) => (party?.company || party?.name || '').replace(/\s+/g, ' ').trim().slice(0, 100) || WALK_IN;
const itemsText = (items = []) => items.map((i) => `${i.name || 'Item'} × ${i.quantity}${i.unit ? ` ${i.unit}` : ''}`).join('; ').slice(0, 300);

// One ledger line: a debit is negative and deemed positive, a credit positive.
function entry(ledger, paise, { party = false, bill = null } = {}) {
  const debit = paise < 0;
  return [
    '<LEDGERENTRIES.LIST>',
    tag('LEDGERNAME', ledger),
    tag('ISDEEMEDPOSITIVE', yesNo(debit)),
    ...(party ? [tag('ISPARTYLEDGER', 'Yes'), tag('ISLASTDEEMEDPOSITIVE', yesNo(debit))] : []),
    tag('AMOUNT', amount(paise)),
    ...(bill ? ['<BILLALLOCATIONS.LIST>', ...(bill.name ? [tag('NAME', bill.name)] : []), tag('BILLTYPE', bill.type), tag('AMOUNT', amount(paise)), '</BILLALLOCATIONS.LIST>'] : []),
    '</LEDGERENTRIES.LIST>',
  ].join(EOL);
}

// The party's line balances the others, so the voucher always balances. REMOTEID: the CRM's own
// id of the document, so Tally can tell a voucher it already has.
function voucher({ id, type, number, date, party, reference, narration, gstin, placeOfSupply, bill, lines }) {
  const partyPaise = -lines.reduce((sum, [, paise]) => sum + paise, 0);
  return [
    `<VOUCHER REMOTEID="crm-${esc(id)}" VCHTYPE="${esc(type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
    tag('DATE', date),
    tag('VOUCHERTYPENAME', type),
    tag('VOUCHERNUMBER', number),
    ...(reference ? [tag('REFERENCE', reference)] : []),
    tag('PARTYLEDGERNAME', party),
    ...(gstin ? [tag('PARTYGSTIN', gstin)] : []),
    ...(placeOfSupply ? [tag('PLACEOFSUPPLY', placeOfSupply)] : []),
    ...(narration ? [tag('NARRATION', narration)] : []),
    tag('PERSISTEDVIEW', 'Accounting Voucher View'),
    tag('ISINVOICE', 'No'),
    entry(party, partyPaise, { party: true, bill }),
    ...lines.map(([ledger, paise]) => entry(ledger, paise)),
    '</VOUCHER>',
  ].join(EOL);
}

// The sales (one ledger, or one per GST rate), GST and round-off lines of an invoice (credits)
// or of a credit note (debits: sign −1). Nothing for amounts of zero.
function documentLines(doc, settings, sign) {
  const { ledgers } = settings;
  const totals = doc.totals || {};
  const lines = [];
  const add = (ledger, paise) => {
    if (paise) lines.push([ledger, sign * paise]);
  };
  if (settings.splitByRate && totals.byRate?.length) {
    for (const rate of totals.byRate) add(`${ledgers.sales} ${rate.ratePct}%`, rate.taxablePaise);
  } else {
    add(ledgers.sales, totals.taxablePaise);
  }
  add(ledgers.cgst, totals.cgstPaise);
  add(ledgers.sgst, totals.sgstPaise); // SGST or UTGST: Tally's "State Tax"
  add(ledgers.igst, totals.igstPaise);
  add(ledgers.roundOff, totals.roundOffPaise);
  return lines;
}

function documentVoucher(doc, settings) {
  const credit = doc.kind === 'credit_note';
  return voucher({
    id: doc._id,
    type: credit ? 'Credit Note' : 'Sales',
    number: doc.number,
    date: tallyDate(doc.invoiceDate),
    party: partyName(doc.billTo),
    reference: credit ? doc.invoiceNumber : doc.orderNumber,
    narration: credit ? `Against ${doc.invoiceNumber}${doc.reason ? `: ${doc.reason}` : ''}` : `Order ${doc.orderNumber}: ${itemsText(doc.items)}`,
    gstin: doc.billTo?.gstin,
    placeOfSupply: stateName(doc.supply?.placeOfSupplyCode),
    bill: credit ? { name: doc.invoiceNumber, type: 'Agst Ref' } : { name: doc.number, type: 'New Ref' },
    lines: documentLines(doc, settings, credit ? -1 : 1),
  });
}

// Cash to the cash ledger, a payment link's money to the gateway ledger, the rest to the bank.
const receiptLedger = (receipt, { ledgers }) => (receipt.method === 'cash' ? ledgers.cash : receipt.source === 'link' ? ledgers.gateway : ledgers.bank);

function receiptVoucher(receipt, settings) {
  const method = receipt.source === 'link' ? 'Payment link' : METHODS[receipt.method] || receipt.method || '';
  return voucher({
    id: receipt._id,
    type: 'Receipt',
    number: receipt.number,
    date: tallyDate(receipt.receiptDate),
    party: partyName(receipt.receivedFrom),
    reference: receipt.reference,
    narration: [`Order ${receipt.orderNumber}`, method, receipt.reference && `Ref ${receipt.reference}`].filter(Boolean).join(' · '),
    bill: receipt.invoiceNumber ? { name: receipt.invoiceNumber, type: 'Agst Ref' } : { type: 'On Account' },
    lines: [[receiptLedger(receipt, settings), -receipt.amountPaise]],
  });
}

// The masters: the customers, then the company's own ledgers that the vouchers use.
function partyLedger(party) {
  const address = [...String(party.address || '').split(/\r?\n|,\s*/), party.city].map((line) => String(line || '').trim()).filter(Boolean).slice(0, 5);
  return [
    `<LEDGER NAME="${esc(party.name)}" ACTION="Create">`,
    tag('NAME', party.name),
    tag('PARENT', 'Sundry Debtors'),
    tag('ISBILLWISEON', 'Yes'),
    '<MAILINGNAME.LIST TYPE="String">', tag('MAILINGNAME', party.name), '</MAILINGNAME.LIST>',
    ...(address.length ? ['<ADDRESS.LIST TYPE="String">', ...address.map((line) => tag('ADDRESS', line)), '</ADDRESS.LIST>'] : []),
    ...(party.state ? [tag('LEDSTATENAME', party.state)] : []),
    ...(party.postalCode ? [tag('PINCODE', party.postalCode)] : []),
    tag('COUNTRYNAME', 'India'),
    tag('GSTREGISTRATIONTYPE', party.gstin ? 'Regular' : 'Unregistered'),
    ...(party.gstin ? [tag('PARTYGSTIN', party.gstin)] : []),
    ...(party.email ? [tag('EMAIL', party.email)] : []),
    ...(party.phone ? [tag('LEDGERMOBILE', party.phone)] : []),
    '</LEDGER>',
  ].join(EOL);
}

function ownLedger({ name, parent, duty }) {
  return [
    `<LEDGER NAME="${esc(name)}" ACTION="Create">`,
    tag('NAME', name),
    tag('PARENT', parent),
    ...(duty ? [tag('TAXTYPE', 'GST'), tag('GSTDUTYHEAD', duty)] : []),
    '</LEDGER>',
  ].join(EOL);
}

// --- the period's documents ---------------------------------------------------------------------
async function load(req, query) {
  const range = rangeOf(query);
  if (range.days > MAX_DAYS) throw httpError(400, 'VALIDATION_ERROR', 'Choose at most a year.', [{ field: 'from', code: 'RANGE_TOO_LONG', message: 'At most 366 days.' }]);
  const organizationId = req.tenant.organizationId;
  const [organization, documents, receipts] = await Promise.all([
    Organization.findById(organizationId).select('settings.tally').lean(),
    TaxInvoice.find({ organizationId, invoiceDate: { $gte: range.start, $lt: range.end } }).sort({ invoiceDate: 1, number: 1 }).limit(MAX_DOCUMENTS + 1).lean(),
    PaymentReceipt.find({ organizationId, status: 'issued', receiptDate: { $gte: range.start, $lt: range.end } }).sort({ receiptDate: 1, number: 1 }).limit(MAX_DOCUMENTS + 1).lean(),
  ]);
  return { range, settings: settingsOf(organization), documents, receipts };
}

// Every customer of the period once (the fullest details win: an invoice's over a receipt's).
function partiesOf(documents, receipts) {
  const parties = new Map();
  for (const doc of documents) {
    const name = partyName(doc.billTo);
    if (parties.has(name) && parties.get(name).fromInvoice) continue;
    const b = doc.billTo || {};
    parties.set(name, { name, fromInvoice: true, address: b.address, city: b.city, state: b.state || stateName(b.stateCode), postalCode: b.postalCode, gstin: b.gstin, email: b.email, phone: b.phone });
  }
  for (const receipt of receipts) {
    const name = partyName(receipt.receivedFrom);
    if (!parties.has(name)) parties.set(name, { name, gstin: receipt.receivedFrom?.gstin || '' });
  }
  return [...parties.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function summaryOf(documents, receipts) {
  const invoices = documents.filter((d) => d.kind === 'invoice');
  const credits = documents.filter((d) => d.kind === 'credit_note');
  const total = (list, field) => list.reduce((sum, item) => sum + (field(item) || 0), 0);
  return {
    invoices: invoices.length,
    invoicesPaise: total(invoices, (d) => d.totals?.grandTotalPaise),
    creditNotes: credits.length,
    creditNotesPaise: total(credits, (d) => d.totals?.grandTotalPaise),
    receipts: receipts.length,
    receiptsPaise: total(receipts, (r) => r.amountPaise),
    parties: partiesOf(documents, receipts).length,
  };
}

// --- the API --------------------------------------------------------------------------------------
// GET /tally?from=&to=: the ledger names and what the period holds.
async function get(req, query) {
  const { range, settings, documents, receipts } = await load(req, query);
  return { ...settings, defaults: DEFAULT_LEDGERS, range: { from: range.from, to: range.to }, summary: summaryOf(documents, receipts) };
}

// PATCH /tally { ledgers?, splitByRate? }
async function update(req, body) {
  const organizationId = req.tenant.organizationId;
  const before = settingsOf(await Organization.findById(organizationId).select('settings.tally').lean());
  const after = { ledgers: { ...before.ledgers, ...body.ledgers }, splitByRate: body.splitByRate ?? before.splitByRate };
  await Organization.updateOne({ _id: organizationId }, { $set: { 'settings.tally': after } });
  await audit(req, { action: 'tally.settings_updated', entityType: 'Organization', entityId: organizationId, changes: { before, after } });
  return after;
}

// GET /tally/export?from=&to=&part=ledgers|vouchers → { fileName, body }
async function exportXml(req, { part, ...query }) {
  const { range, settings, documents, receipts } = await load(req, query);
  if (documents.length > MAX_DOCUMENTS || receipts.length > MAX_DOCUMENTS) {
    throw httpError(400, 'TOO_MANY', 'More than 10,000 documents in this period: choose a shorter one.');
  }
  let body;
  if (part === 'ledgers') {
    const { ledgers } = settings;
    const own = new Map();
    const use = (name, parent, duty) => {
      if (!own.has(name)) own.set(name, { name, parent, duty });
    };
    for (const doc of documents) {
      for (const [name] of documentLines(doc, settings, 1)) {
        if (name === ledgers.cgst) use(name, 'Duties & Taxes', 'Central Tax');
        else if (name === ledgers.sgst) use(name, 'Duties & Taxes', 'State Tax');
        else if (name === ledgers.igst) use(name, 'Duties & Taxes', 'Integrated Tax');
        else if (name === ledgers.roundOff) use(name, 'Indirect Expenses');
        else use(name, 'Sales Accounts');
      }
    }
    for (const receipt of receipts) {
      const name = receiptLedger(receipt, settings);
      use(name, name === ledgers.cash ? 'Cash-in-Hand' : 'Bank Accounts');
    }
    body = envelope('All Masters', [...partiesOf(documents, receipts).map(partyLedger), ...[...own.values()].map(ownLedger)]);
  } else {
    body = envelope('Vouchers', [...documents.map((doc) => documentVoucher(doc, settings)), ...receipts.map((receipt) => receiptVoucher(receipt, settings))]);
  }
  const summary = summaryOf(documents, receipts);
  await audit(req, {
    action: 'tally.exported', entityType: 'Organization', entityId: req.tenant.organizationId,
    changes: { part, from: range.from, to: range.to, invoices: summary.invoices, creditNotes: summary.creditNotes, receipts: summary.receipts },
  });
  return { fileName: `tally-${part}-${range.from}-to-${range.to}.xml`, body };
}

module.exports = { DEFAULT_LEDGERS, LEDGER_KEYS, settingsOf, get, update, exportXml };
