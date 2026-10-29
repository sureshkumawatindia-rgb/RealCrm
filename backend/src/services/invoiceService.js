const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const MessageTemplate = require('../models/MessageTemplate');
const Order = require('../models/Order');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const PaymentReceipt = require('../models/PaymentReceipt');
const Quotation = require('../models/Quotation');
const TaxInvoice = require('../models/TaxInvoice');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { nextSequence } = require('../utils/counter');
const { financialYear, formatRupees } = require('../utils/money');
const { roundDiv, supplyFor, priceDocument } = require('../utils/gst');
const { stateCodeFromGstin, normalizeGstin } = require('../utils/gstin');
const { stateCodeFor, stateName } = require('../constants/gst');
const { visibilityFilter } = require('./access');
const { billingOf, sellerStateCode } = require('./organizationService');
const leadService = require('./leadService');
const conversationService = require('./conversationService');
const templateService = require('./templateService');
const quotationService = require('./quotationService');
const { renderInvoicePdf, renderReceiptPdf, fileNameOf } = require('./invoicePdf');

// GST tax invoices, credit notes and payment receipts for orders (D101; CGST Rules 46 and 53,
// checked on 2026-10-28, docs/GST_INVOICES.md). An invoice is made from an order by hand (or
// when the order is dispatched, if Settings → Billing says so), priced again with utils/gst
// for the place of supply, and never edited: a credit note takes back all of it or part of its
// lines. Every payment on an order gets a receipt. Numbers run without gaps per financial year
// (the counter moves in the same transaction as the document): INV/26-27/0001.
const MODULES = leadService.MODULES; // orders follow leads and deals
const KINDS = { invoice: 'invoice', credit_note: 'creditNote', receipt: 'receipt' };
const NAMES = { invoice: 'Tax invoice', credit_note: 'Credit note', receipt: 'Receipt' };
const BIG_UNREGISTERED_PAISE = 50000 * 100; // Rule 46(e): ₹50,000 of taxable value
const PARTY_FIELDS = ['name', 'company', 'gstin', 'address', 'city', 'state', 'postalCode'];
const plain = (value) => (value?.toObject ? value.toObject() : value);
const orders = () => require('./orderService'); // eslint-disable-line global-require -- it uses this service
const by = (req) => ({ createdById: req.user._id, createdByName: req.user.name || '' });

// --- numbers ------------------------------------------------------------------------------
// INV/26-27/0001: the prefix (Settings → Billing), the financial year and a counter of its own.
async function nextNumber(organization, kind, session) {
  const year = financialYear();
  const seq = await nextSequence(organization._id, `${kind}:${year}`, { session });
  const prefix = billingOf(organization).prefixes[KINDS[kind]];
  const number = `${prefix}/${year.slice(2)}/${String(seq).padStart(4, '0')}`;
  if (number.length > 16) {
    throw httpError(409, 'NUMBERS_FULL', `${NAMES[kind]} numbers of ${year} would pass GST's 16 characters with the prefix ${prefix}. Use a shorter prefix in Settings → Billing.`);
  }
  return { number, financialYear: year };
}

// --- reading -------------------------------------------------------------------------------
async function orderOf(req, orderId, session) {
  const order = await Order.findOne({ _id: orderId, organizationId: req.tenant.organizationId, ...visibilityFilter(req, MODULES) }).session(session || null);
  if (!order) throw httpError(404, 'NOT_FOUND', 'Order not found');
  return order;
}

// An invoice or credit note this member may see (through its order).
async function findVisible(req, id, session) {
  const invoice = mongoose.isValidObjectId(id) ? await TaxInvoice.findOne({ _id: id, organizationId: req.tenant.organizationId }).session(session || null) : null;
  if (!invoice) throw httpError(404, 'NOT_FOUND', 'Invoice not found');
  await orderOf(req, invoice.orderId, session);
  return invoice;
}

async function receiptOf(req, id) {
  const receipt = mongoose.isValidObjectId(id) ? await PaymentReceipt.findOne({ _id: id, organizationId: req.tenant.organizationId }) : null;
  if (!receipt) throw httpError(404, 'NOT_FOUND', 'Receipt not found');
  await orderOf(req, receipt.orderId);
  return receipt;
}

// What is left of each invoice line once its credit notes are taken off.
function remainingOf(invoice) {
  return (invoice.items || []).map((item, index) => {
    const done = (invoice.credited || []).find((c) => c.lineIndex === index) || {};
    return {
      quantity: Math.max(Math.round(((item.quantity || 0) - (done.quantity || 0)) * 1000) / 1000, 0),
      taxablePaise: (item.taxablePaise || 0) - (done.taxablePaise || 0),
      cgstPaise: (item.cgstPaise || 0) - (done.cgstPaise || 0),
      sgstPaise: (item.sgstPaise || 0) - (done.sgstPaise || 0),
      igstPaise: (item.igstPaise || 0) - (done.igstPaise || 0),
    };
  });
}

function serializeInvoice(invoice) {
  return {
    id: invoice._id,
    kind: invoice.kind,
    number: invoice.number,
    financialYear: invoice.financialYear,
    invoiceDate: invoice.invoiceDate,
    orderId: invoice.orderId,
    orderNumber: invoice.orderNumber || '',
    contactId: invoice.contactId || null,
    seller: plain(invoice.seller) || {},
    billTo: plain(invoice.billTo) || {},
    supply: { ...(plain(invoice.supply) || {}), placeOfSupply: stateName(invoice.supply?.placeOfSupplyCode) },
    items: (invoice.items || []).map(plain),
    totals: plain(invoice.totals) || {},
    status: invoice.status,
    creditedPaise: invoice.creditedPaise || 0,
    ...(invoice.kind === 'invoice' && { remaining: remainingOf(invoice) }),
    invoiceId: invoice.invoiceId || null,
    invoiceNumber: invoice.invoiceNumber || '',
    originalDate: invoice.originalDate || null,
    reason: invoice.reason || '',
    full: Boolean(invoice.full),
    auto: Boolean(invoice.auto),
    sentAt: invoice.sentAt || null,
    createdByName: invoice.createdByName || '',
    createdAt: invoice.createdAt,
  };
}

function serializeReceipt(receipt) {
  return {
    id: receipt._id,
    number: receipt.number,
    receiptDate: receipt.receiptDate,
    orderId: receipt.orderId,
    orderNumber: receipt.orderNumber || '',
    paymentId: receipt.paymentId,
    invoiceNumber: receipt.invoiceNumber || '',
    receivedFrom: plain(receipt.receivedFrom) || {},
    amountPaise: receipt.amountPaise,
    source: receipt.source || '',
    method: receipt.method || '',
    reference: receipt.reference || '',
    status: receipt.status,
    sentAt: receipt.sentAt || null,
    createdAt: receipt.createdAt,
  };
}

// GET /orders/:id/invoices — the order's invoices (each with its credit notes) and receipts.
async function forOrder(req, orderId) {
  const order = await orderOf(req, orderId);
  const [documents, receipts, organization] = await Promise.all([
    TaxInvoice.find({ organizationId: order.organizationId, orderId: order._id }).sort({ createdAt: 1 }),
    PaymentReceipt.find({ organizationId: order.organizationId, orderId: order._id }).sort({ createdAt: 1 }),
    Organization.findById(order.organizationId),
  ]);
  const invoices = documents.filter((d) => d.kind === 'invoice').map((invoice) => ({
    ...serializeInvoice(invoice),
    creditNotes: documents.filter((d) => d.kind === 'credit_note' && String(d.invoiceId) === String(invoice._id)).map(serializeInvoice),
  }));
  const billing = billingOf(organization);
  return {
    invoices,
    receipts: receipts.map(serializeReceipt),
    canInvoice: order.stage !== 'Cancelled' && !invoices.some((i) => i.status === 'issued'),
    invoiceOnDispatch: billing.invoiceOnDispatch,
    sellerReady: Boolean(organization?.gstin && organization?.address),
  };
}

// --- the invoice ------------------------------------------------------------------------------
// The customer as the order has them, with the details corrected before invoicing (address,
// GSTIN, state as a name or GST code): a GSTIN decides the state.
function partyFor(base, input) {
  const party = { ...(plain(base) || {}) };
  if (!input) return party;
  for (const field of PARTY_FIELDS) if (typeof input[field] === 'string') party[field] = input[field].trim();
  party.gstin = normalizeGstin(party.gstin);
  const chosen = input.state !== undefined ? stateCodeFor(input.state) : party.stateCode || stateCodeFor(party.state);
  party.stateCode = stateCodeFromGstin(party.gstin) || chosen || '';
  if (party.stateCode) party.state = stateName(party.stateCode);
  return party;
}

// The order's lines priced again for this invoice's place of supply (the same money engine as
// quotations; the same amounts unless the customer's state or GSTIN was corrected).
function priceInvoice(order, organization, billTo, { placeChanged }) {
  const supply = supplyFor({
    sellerStateCode: sellerStateCode(organization),
    buyerGstin: billTo.gstin,
    buyerStateCode: billTo.stateCode,
    buyerState: billTo.state,
    placeOfSupplyCode: placeChanged ? '' : order.supply?.placeOfSupplyCode,
    zeroRated: order.supply?.zeroRated,
  });
  const priced = priceDocument((order.items || []).map(plain), supply, { roundOff: billingOf(organization).roundOff });
  const { sellerStateCode: sellerCode, placeOfSupplyCode, interState, zeroRated, taxLabel, stateAssumed } = supply;
  return { supply: { sellerStateCode: sellerCode, placeOfSupplyCode, interState, zeroRated, taxLabel, stateAssumed }, items: priced.items, totals: priced.totals, warnings: supply.warnings };
}

// A tax invoice shows the seller's GSTIN and address (Rule 46(a)).
function sellerReady(organization) {
  const seller = quotationService.sellerOf(organization);
  if (!seller.gstin) throw httpError(422, 'SELLER_GSTIN_REQUIRED', 'Add your GSTIN in Settings → Company first: a tax invoice must show it.');
  if (!seller.address) throw httpError(422, 'SELLER_ADDRESS_REQUIRED', 'Add your address in Settings → Company first: a tax invoice must show it.');
  return seller;
}

// POST /orders/:id/invoice { billTo? } — the order's tax invoice, once (another only after this
// one is credited in full). auto: made when the order was dispatched.
async function createForOrder(req, orderId, { billTo: corrections, auto = false } = {}) {
  let invoice;
  let warnings = [];
  await mongoose.connection.transaction(async (session) => {
    invoice = null;
    const order = await orderOf(req, orderId, session);
    if (order.stage === 'Cancelled') throw httpError(409, 'ORDER_CANCELLED', 'This order was cancelled: it gets no invoice.');
    const live = await TaxInvoice.findOne({ organizationId: order.organizationId, orderId: order._id, kind: 'invoice', status: 'issued' }).session(session);
    if (live) throw httpError(409, 'INVOICE_EXISTS', `This order already has tax invoice ${live.number}. Fix a mistake in it with a credit note.`, [{ field: 'orderId', code: 'INVOICE_EXISTS', message: String(live._id) }]);
    const organization = await Organization.findById(order.organizationId).session(session);
    const seller = sellerReady(organization);
    const billTo = partyFor(order.billTo, corrections);
    if (!billTo.name) throw httpError(422, 'BUYER_NAME_REQUIRED', 'Add the customer\'s name for the invoice.', [{ field: 'billTo.name', code: 'REQUIRED', message: 'Add the customer\'s name.' }]);
    // A new GSTIN or state moves the place of supply to the customer's state.
    const placeChanged = Boolean(corrections) && (billTo.gstin !== (order.billTo?.gstin || '') || billTo.stateCode !== (order.billTo?.stateCode || ''));
    const priced = priceInvoice(order, organization, billTo, { placeChanged });
    // Rule 46(e): to someone without a GSTIN, from ₹50,000 of taxable value, their address.
    if (!billTo.gstin && priced.totals.taxablePaise >= BIG_UNREGISTERED_PAISE && !(billTo.address && billTo.stateCode)) {
      throw httpError(422, 'BUYER_ADDRESS_REQUIRED', 'For ₹50,000 or more to a customer without a GSTIN, GST asks for their address and state on the invoice. Add them first.', [{ field: 'billTo.address', code: 'REQUIRED', message: 'Add the customer\'s address and state.' }]);
    }
    warnings = priced.warnings.filter((w) => w.code !== 'SELLER_STATE_UNKNOWN');
    if (billTo.gstin && priced.items.some((item) => !item.hsnSac)) warnings.push({ code: 'HSN_MISSING', message: 'Some lines have no HSN/SAC code: a B2B invoice needs one. Add them to the products for the next invoices.' });
    const { number, financialYear: year } = await nextNumber(organization, 'invoice', session);
    [invoice] = await TaxInvoice.create([{
      organizationId: order.organizationId, kind: 'invoice', number, financialYear: year, invoiceDate: new Date(),
      orderId: order._id, orderNumber: order.number, quotationId: order.quotationId, leadId: order.leadId, contactId: order.contactId, ownerId: order.ownerId,
      seller, billTo, supply: priced.supply, items: priced.items, totals: priced.totals, terms: billingOf(organization).terms || '', auto, ...by(req),
    }], { session });
    await billOrder(order, priced.totals.grandTotalPaise, session);
    const lead = order.leadId ? await Lead.findById(order.leadId).session(session) : null;
    if (lead) await leadService.addActivity(req, lead, 'Invoice', `Tax invoice ${number} made for order ${order.number} (${formatRupees(priced.totals.grandTotalPaise)})${auto ? ' when it was dispatched' : ''}`, { session });
  });
  await audit(req, { action: 'invoice.created', entityType: 'TaxInvoice', entityId: invoice._id, changes: { number: invoice.number, orderId: String(invoice.orderId), totalPaise: invoice.totals.grandTotalPaise, auto } });
  return { invoice: serializeInvoice(invoice), warnings };
}

// What the order owes moves with its invoices and credit notes (Order.billedPaise); paid in full
// by that, it counts as paid (and no longer when a new invoice bills more).
async function billOrder(order, changePaise, session) {
  order.billedPaise = (order.billedPaise || 0) + changePaise;
  const paid = orders().paymentStatusOf(order) === 'paid';
  if (paid && !order.paidAt) order.paidAt = new Date();
  if (!paid) order.paidAt = undefined;
  await order.save({ session });
}

// POST /quotations/:id/invoice — from an accepted quotation: its order (made now if needed), then
// the invoice.
async function createForQuotation(req, quotationId, body = {}) {
  const quotation = await Quotation.findOne({ _id: quotationId, organizationId: req.tenant.organizationId, ...visibilityFilter(req, MODULES) });
  if (!quotation) throw httpError(404, 'NOT_FOUND', 'Quotation not found');
  let orderId = quotation.orderId;
  if (!orderId) {
    sellerReady(await Organization.findById(quotation.organizationId)); // before an order is made for nothing
    orderId = (await orders().create(req, { quotationId })).id;
  }
  return { orderId, ...(await createForOrder(req, orderId, body)) };
}

// --- credit notes ---------------------------------------------------------------------------
// GST on a credit note can be taken off only until 30 November after the invoice's financial
// year (CGST Act section 34(2)); later, the note is made but says so.
function creditDeadline(invoice) {
  const endYear = Number(String(invoice.financialYear).slice(0, 4)) + 1;
  return new Date(`${endYear}-11-30T23:59:59+05:30`);
}

// One line taken back: a quantity of it (goods returned, at what is left of its value per
// unit) or an amount off its taxable value (a price corrected). The tax follows the invoice's
// rate and split; the last of a line is taken exactly, so credit notes never take back more,
// or less, than the invoice had. null: more than is left.
const milli = (quantity) => Math.round((Number(quantity) || 0) * 1000);
function creditLine(item, left, supply, { quantity, taxablePaise }) {
  let taxable;
  let qty = 0;
  if (quantity !== undefined) {
    qty = milli(quantity) / 1000;
    if (!(qty > 0) || qty > left.quantity) return null;
    taxable = qty === left.quantity ? left.taxablePaise : Math.min(roundDiv(left.taxablePaise * milli(qty), milli(left.quantity)), left.taxablePaise);
  } else {
    taxable = Math.round(Number(taxablePaise) || 0);
    if (taxable > left.taxablePaise) return null;
  }
  if (!(taxable > 0)) return null;
  const rate = supply.zeroRated ? 0 : Math.round((Number(item.gstRatePct) || 0) * 100);
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (taxable === left.taxablePaise) ({ cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst } = left); // the rest of the line
  else if (supply.interState) igst = Math.min(roundDiv(taxable * rate, 10000), left.igstPaise);
  else {
    cgst = Math.min(roundDiv(taxable * rate, 20000), left.cgstPaise);
    sgst = Math.min(cgst, left.sgstPaise);
  }
  const tax = cgst + sgst + igst;
  return {
    name: item.name, description: item.description || '', hsnSac: item.hsnSac || '', unit: item.unit || '', productId: item.productId,
    quantity: qty, unitPricePaise: qty ? roundDiv(taxable * 1000, milli(qty)) : 0, discountType: 'amount', discountValue: 0,
    subtotalPaise: taxable, discountPaise: 0, taxablePaise: taxable, gstRatePct: item.gstRatePct || 0,
    cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst, taxPaise: tax, totalPaise: taxable + tax,
  };
}

// POST /invoices/:id/credit-notes { full } or { lines: [{ index, quantity | taxablePaise }] },
// with a reason.
async function creditNote(req, invoiceId, { full = false, lines = [], reason }) {
  let note;
  let invoice;
  await mongoose.connection.transaction(async (session) => {
    note = null;
    invoice = await findVisible(req, invoiceId, session);
    if (invoice.kind !== 'invoice') throw httpError(400, 'NOT_AN_INVOICE', 'A credit note is made against a tax invoice.');
    if (invoice.status !== 'issued') throw httpError(409, 'ALREADY_CREDITED', `Invoice ${invoice.number} was already taken back in full.`);
    const left = remainingOf(invoice);
    // In full: whatever is left of every line (its quantity, or its amount once only money is left).
    const wanted = full
      ? left.map((l, index) => ({ index, ...(l.quantity > 0 ? { quantity: l.quantity } : { taxablePaise: l.taxablePaise }) })).filter((w, i) => left[i].taxablePaise > 0)
      : lines;
    const items = [];
    const seen = new Set();
    for (const line of wanted) {
      const item = invoice.items[line.index];
      if (!item || seen.has(line.index)) throw httpError(400, 'VALIDATION_ERROR', 'A line of the invoice is unknown or given twice.', [{ field: 'lines', code: 'INVALID_LINE', message: 'Pick each line once.' }]);
      seen.add(line.index);
      const rest = left[line.index];
      const credit = creditLine(item, rest, invoice.supply, line);
      if (!credit) {
        const what = !rest.taxablePaise ? 'nothing' : line.quantity !== undefined ? `only ${rest.quantity}${item.unit ? ` ${item.unit}` : ''}` : `only ${formatRupees(rest.taxablePaise)}`;
        const message = `Line ${line.index + 1} (${item.name}) has ${what} left to take back.`;
        throw httpError(400, 'VALIDATION_ERROR', message, [{ field: `lines.${line.index}`, code: 'TOO_MUCH', message }]);
      }
      items.push({ ...credit, lineIndex: line.index });
    }
    if (!items.length) throw httpError(400, 'VALIDATION_ERROR', 'Pick what to take back.', [{ field: 'lines', code: 'REQUIRED', message: 'Pick at least one line.' }]);
    const sum = (field) => items.reduce((total, item) => total + (item[field] || 0), 0);
    const exact = sum('totalPaise');
    // The last credit note brings the credits to the invoice's own total (its round-off too).
    const leftAfter = left.map((l, index) => {
      const credit = items.find((item) => item.lineIndex === index);
      return credit ? l.taxablePaise - credit.taxablePaise + (l.cgstPaise - credit.cgstPaise) + (l.sgstPaise - credit.sgstPaise) + (l.igstPaise - credit.igstPaise) : l.taxablePaise + l.cgstPaise + l.sgstPaise + l.igstPaise;
    });
    const closes = leftAfter.every((amount) => amount === 0);
    const grandTotalPaise = closes ? invoice.totals.grandTotalPaise - (invoice.creditedPaise || 0) : exact;
    // A rounded-down invoice: the paise left over are only taken back with the rest of it.
    if (!closes && (invoice.creditedPaise || 0) + exact > invoice.totals.grandTotalPaise) {
      const message = `This would take back more than the invoice's ${formatRupees(invoice.totals.grandTotalPaise)}. Take back the whole invoice instead.`;
      throw httpError(400, 'VALIDATION_ERROR', message, [{ field: 'lines', code: 'TOO_MUCH', message }]);
    }
    const rates = [...new Set(items.map((item) => item.gstRatePct))].sort((a, b) => a - b);
    const totals = {
      subtotalPaise: sum('subtotalPaise'), discountPaise: 0, taxablePaise: sum('taxablePaise'), cgstPaise: sum('cgstPaise'), sgstPaise: sum('sgstPaise'),
      igstPaise: sum('igstPaise'), taxPaise: sum('taxPaise'), roundOffPaise: grandTotalPaise - exact, grandTotalPaise,
      byRate: rates.map((ratePct) => {
        const group = items.filter((item) => item.gstRatePct === ratePct);
        const add = (field) => group.reduce((total, item) => total + item[field], 0);
        return { ratePct, taxablePaise: add('taxablePaise'), cgstPaise: add('cgstPaise'), sgstPaise: add('sgstPaise'), igstPaise: add('igstPaise'), taxPaise: add('taxPaise') };
      }),
    };
    const organization = await Organization.findById(invoice.organizationId).session(session);
    const { number, financialYear: year } = await nextNumber(organization, 'credit_note', session);
    [note] = await TaxInvoice.create([{
      organizationId: invoice.organizationId, kind: 'credit_note', number, financialYear: year, invoiceDate: new Date(),
      orderId: invoice.orderId, orderNumber: invoice.orderNumber, quotationId: invoice.quotationId, leadId: invoice.leadId, contactId: invoice.contactId, ownerId: invoice.ownerId,
      seller: plain(invoice.seller), billTo: plain(invoice.billTo), supply: plain(invoice.supply), items, totals,
      invoiceId: invoice._id, invoiceNumber: invoice.number, originalDate: invoice.invoiceDate, reason: String(reason || '').trim(), full: closes, ...by(req),
    }], { session });
    for (const item of items) {
      let done = invoice.credited.find((c) => c.lineIndex === item.lineIndex);
      if (!done) {
        invoice.credited.push({ lineIndex: item.lineIndex });
        done = invoice.credited[invoice.credited.length - 1];
      }
      done.quantity = Math.round(((done.quantity || 0) + item.quantity) * 1000) / 1000;
      for (const field of ['taxablePaise', 'cgstPaise', 'sgstPaise', 'igstPaise']) done[field] = (done[field] || 0) + item[field];
    }
    invoice.creditedPaise = (invoice.creditedPaise || 0) + grandTotalPaise;
    if (closes) invoice.status = 'credited';
    await invoice.save({ session });
    const order = await Order.findById(invoice.orderId).session(session);
    if (order) await billOrder(order, -grandTotalPaise, session);
    const lead = invoice.leadId ? await Lead.findById(invoice.leadId).session(session) : null;
    if (lead) await leadService.addActivity(req, lead, 'Invoice', `Credit note ${number} against ${invoice.number} (${formatRupees(grandTotalPaise)})${closes ? ': the invoice is taken back in full' : ''}. ${note.reason}`, { session });
  });
  await audit(req, { action: 'invoice.credit_note', entityType: 'TaxInvoice', entityId: note._id, changes: { number: note.number, invoice: invoice.number, totalPaise: note.totals.grandTotalPaise, full: note.full } });
  const warnings = Date.now() > creditDeadline(invoice).getTime()
    ? [{ code: 'GST_TIME_LIMIT', message: `The GST on it can no longer be taken off in your returns: the time for invoices of ${invoice.financialYear} ended on 30 Nov ${creditDeadline(invoice).getFullYear()}.` }]
    : [];
  return { creditNote: serializeInvoice(note), invoice: serializeInvoice(invoice), warnings };
}

// --- receipts --------------------------------------------------------------------------------
// The receipt of one payment, inside the transaction that records it (orderService).
async function issueReceipt(order, payment, { session } = {}) {
  const organization = await Organization.findById(order.organizationId).session(session || null);
  const { number, financialYear: year } = await nextNumber(organization, 'receipt', session);
  const invoice = await TaxInvoice.findOne({ organizationId: order.organizationId, orderId: order._id, kind: 'invoice', status: 'issued' }).session(session || null);
  const [receipt] = await PaymentReceipt.create([{
    organizationId: order.organizationId, number, financialYear: year, receiptDate: payment.paidAt || new Date(),
    orderId: order._id, orderNumber: order.number, paymentId: payment._id, invoiceId: invoice?._id, invoiceNumber: invoice?.number || '',
    contactId: order.contactId, ownerId: order.ownerId,
    receivedFrom: { name: order.billTo?.name || '', company: order.billTo?.company || '', gstin: order.billTo?.gstin || '' },
    amountPaise: payment.amountPaise, source: payment.source, method: payment.method || '', reference: payment.reference || '',
  }], { session });
  return receipt;
}

// A payment removed (entered by mistake): its receipt stays, cancelled, so no number is missing.
function cancelReceipt(order, paymentId, { session } = {}) {
  return PaymentReceipt.updateOne({ organizationId: order.organizationId, paymentId, status: 'issued' }, { $set: { status: 'cancelled', cancelledAt: new Date() } }, { session });
}

// POST /orders/:id/payments/:paymentId/receipt — the receipt of a payment from before D101.
async function ensureReceipt(req, orderId, paymentId) {
  let receipt;
  await mongoose.connection.transaction(async (session) => {
    const order = await orderOf(req, orderId, session);
    const payment = order.payments.id(paymentId);
    if (!payment) throw httpError(404, 'NOT_FOUND', 'Payment not found');
    receipt = await PaymentReceipt.findOne({ organizationId: order.organizationId, paymentId: payment._id }).session(session);
    if (!receipt) receipt = await issueReceipt(order, payment, { session });
  });
  return serializeReceipt(receipt);
}

// --- PDFs ----------------------------------------------------------------------------------------
async function documentPdf(invoice) {
  const [organization, order] = await Promise.all([Organization.findById(invoice.organizationId), Order.findById(invoice.orderId)]);
  const buffer = await renderInvoicePdf({ invoice, organization, order });
  return { buffer, fileName: fileNameOf(invoice.number) };
}

async function receiptPdf(receipt) {
  const [organization, order] = await Promise.all([Organization.findById(receipt.organizationId), Order.findById(receipt.orderId)]);
  const buffer = await renderReceiptPdf({ receipt, organization, order, seller: quotationService.sellerOf(organization) });
  return { buffer, fileName: fileNameOf(receipt.number) };
}

// --- sending in the WhatsApp chat ------------------------------------------------------------------
async function memberLabel(id) {
  const member = id ? await OrganizationMember.findById(id).populate('userId', 'name') : null;
  return member?.displayName || member?.userId?.name || 'a teammate';
}

// What a template's blanks take: the customer's name, the document's number and amount.
function suggestionsFor(facts) {
  const byName = (name) => {
    const key = String(name).toLowerCase();
    if (/name/.test(key)) return facts.name;
    if (/amount|total|price|value/.test(key)) return facts.total;
    if (/number|invoice|receipt|note|ref|doc/.test(key)) return facts.number;
    return '';
  };
  const ORDER = [facts.name, facts.number, facts.total];
  return (template) => {
    const shape = templateService.shapeOf(template, { withDocument: true });
    const named = template.parameterFormat === 'NAMED';
    const fill = (names) => Object.fromEntries(names.map((name, i) => [name, (named ? byName(name) : ORDER[Number(name) - 1] ?? ORDER[i]) || '']));
    return { header: fill(shape.header?.variables || []), body: fill(shape.body.variables), buttons: {} };
  };
}

async function loaded(req, kind, id) {
  if (kind === 'receipt') {
    const receipt = await receiptOf(req, id);
    return {
      doc: receipt, model: PaymentReceipt, contactId: receipt.contactId, name: receipt.receivedFrom?.name || '',
      label: `receipt ${receipt.number} for ${formatRupees(receipt.amountPaise)}`, file: () => receiptPdf(receipt),
      total: formatRupees(receipt.amountPaise),
    };
  }
  const invoice = await findVisible(req, id);
  const what = invoice.kind === 'invoice' ? 'tax invoice' : 'credit note';
  return {
    doc: invoice, model: TaxInvoice, contactId: invoice.contactId, name: invoice.billTo?.name || '',
    label: `${what} ${invoice.number} for ${formatRupees(invoice.totals?.grandTotalPaise)}`, file: () => documentPdf(invoice),
    total: formatRupees(invoice.totals?.grandTotalPaise),
  };
}

async function chatOf(organizationId, contactId) {
  return Conversation.findOne({ organizationId, contactId }).sort({ lastMessageAt: -1, updatedAt: -1 });
}

// GET /invoices/:id/send-options, /receipts/:id/send-options — as a document now (inside the
// 24 hours), or only as a template with a document header.
async function sendOptions(req, kind, id) {
  const item = await loaded(req, kind, id);
  const organizationId = req.tenant.organizationId;
  const contact = item.contactId ? await Contact.findOne({ _id: item.contactId, organizationId }) : null;
  const conversation = contact ? await chatOf(organizationId, contact._id) : null;
  const account = conversation
    ? await WhatsAppAccount.findOne({ _id: conversation.whatsappAccountId, organizationId })
    : await WhatsAppAccount.findOne({ organizationId }).sort({ isDefault: -1, createdAt: 1 });
  let blocked = '';
  if (!contact?.phoneE164) blocked = `${contact?.name || 'The customer'} has no mobile number. Add it to the customer first.`;
  else if (!account) blocked = 'Add a WhatsApp number in Settings → WhatsApp first.';
  else if (conversation?.assigneeId && !conversationService.seesAll(req.member) && String(conversation.assigneeId) !== String(req.member._id)) {
    blocked = `${await memberLabel(conversation.assigneeId)} is handling this customer's WhatsApp chat.`;
  }
  const suggest = suggestionsFor({ name: item.name || contact?.name || '', number: item.doc.number, total: item.total });
  const templates = account
    ? (await MessageTemplate.find({ organizationId, whatsappAccountId: account._id, status: 'APPROVED' }).sort({ name: 1 }))
      .filter((template) => templateService.shapeOf(template, { withDocument: true }).sendable)
      .map((template) => ({ ...templateService.serializeTemplate(template), suggested: suggest(template) }))
    : [];
  return {
    blocked,
    phone: contact?.phoneE164 || '',
    account: account ? { id: account._id, name: account.name || account.verifiedName || '', phone: account.displayPhone || '' } : null,
    conversation: conversation ? { id: conversation._id, windowOpen: conversationService.serviceWindow(conversation).open } : null,
    caption: `Namaste ${item.name || contact?.name || ''}, please find our ${item.label}.`.slice(0, 1024),
    templates,
  };
}

// POST /invoices/:id/send, /receipts/:id/send { mode: document | template, caption?, templateId?, variables? }
async function send(req, kind, id, { mode, caption = '', templateId, variables }) {
  const item = await loaded(req, kind, id);
  const organizationId = req.tenant.organizationId;
  const contact = item.contactId ? await Contact.findOne({ _id: item.contactId, organizationId }) : null;
  if (!contact?.phoneE164) throw httpError(409, 'NO_PHONE', `${contact?.name || 'The customer'} has no mobile number. Add it to the customer first.`);
  let conversation = await chatOf(organizationId, contact._id);
  if (mode === 'document' && !(conversation && conversationService.serviceWindow(conversation).open)) {
    throw httpError(422, 'WINDOW_CLOSED', 'The customer has not written in the last 24 hours. WhatsApp only allows an approved template now.');
  }
  if (!conversation) {
    const started = await conversationService.start(req, { contactId: contact._id });
    conversation = await Conversation.findById(started.conversation.id);
  } else if (conversation.assigneeId && !conversationService.seesAll(req.member) && String(conversation.assigneeId) !== String(req.member._id)) {
    throw httpError(409, 'CHAT_ASSIGNED', `${await memberLabel(conversation.assigneeId)} is handling this customer's WhatsApp chat.`);
  }
  const { buffer, fileName } = await item.file();
  const message = await conversationService.sendGeneratedDocument(req, conversation._id, {
    buffer, fileName, caption: mode === 'document' ? caption : '', templateId: mode === 'template' ? templateId : undefined, variables,
  });
  if (message.status === 'failed') {
    throw httpError(502, 'WHATSAPP_REFUSED', `WhatsApp did not accept it: ${message.error?.message || 'unknown reason'}. The attempt shows in the chat.`);
  }
  await item.model.updateOne({ _id: item.doc._id }, { $set: { sentAt: new Date() } });
  await audit(req, { action: `${kind === 'receipt' ? 'receipt' : 'invoice'}.sent_whatsapp`, entityType: kind === 'receipt' ? 'PaymentReceipt' : 'TaxInvoice', entityId: item.doc._id, changes: { mode, templateId: templateId || null } });
  return { message, conversationId: conversation._id };
}

module.exports = {
  forOrder, createForOrder, createForQuotation, creditNote, issueReceipt, cancelReceipt, ensureReceipt,
  pdf: async (req, id) => documentPdf(await findVisible(req, id)),
  receiptPdf: async (req, id) => receiptPdf(await receiptOf(req, id)),
  sendOptions, send, serializeInvoice, serializeReceipt, remainingOf, creditLine, nextNumber, findVisible,
};
