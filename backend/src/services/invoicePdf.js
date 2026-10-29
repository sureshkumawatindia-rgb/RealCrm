const { amountInWords, formatRupees } = require('../utils/money');
const { billingOf } = require('./organizationService');
const {
  renderDocumentPdf, startPdf, drawHeader, drawSignature, finishPdf, upiLink, logoOf, num, day, COLOR, LEFT, WIDTH,
} = require('./quotationPdf');

// The PDFs of tax invoices and credit notes (D101: the quotation layout, services/quotationPdf.js)
// and of payment receipts. What an invoice must show is CGST Rule 46, a credit note Rule 53(1A)
// (docs/GST_INVOICES.md): the customer's state with its code, the place of supply, HSN/SAC,
// the CGST/SGST or IGST split by rate, "Reverse charge: No" and a signature line. The
// customer's phone and email are left out (they may be masked for the member who sends it).
const METHODS = {
  cash: 'Cash', bank_transfer: 'Bank transfer', cheque: 'Cheque', card: 'Card', upi: 'UPI',
  netbanking: 'Net banking', wallet: 'Wallet', emi: 'EMI', other: 'Other',
};

const fileNameOf = (number) => `${String(number).replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`;

// What the customer still owes on an invoice: its total, less its credit notes and what the
// order was paid.
function dueOf(invoice, order) {
  const net = (invoice.totals?.grandTotalPaise || 0) - (invoice.creditedPaise || 0);
  const paid = order?.amountPaidPaise || 0;
  return { net, paid, due: Math.max(net - paid, 0), excess: Math.max(paid - net, 0) };
}

async function renderInvoicePdf({ invoice, organization, order }) {
  const credit = invoice.kind === 'credit_note';
  const billing = billingOf(organization);
  const { paid, due, excess } = dueOf(invoice, order);
  const afterTotal = [];
  if (!credit) {
    if (invoice.creditedPaise) afterTotal.push(['Credit notes', `− ${num(invoice.creditedPaise)}`]);
    if (paid) afterTotal.push(['Amount paid', `− ${num(paid)}`]);
    if (excess) afterTotal.push(['Paid in excess', formatRupees(excess), true]);
    else if (invoice.creditedPaise || paid) afterTotal.push(['Balance due', formatRupees(due), true]);
  }
  // The UPI QR asks for what is still due.
  const payment = !credit && due > 0 && billing.upiId
    ? { upiId: billing.upiId, amountPaise: due, link: upiLink({ upiId: billing.upiId, payee: billing.bank.accountName || organization?.name, amountPaise: due, note: invoice.number }) }
    : null;
  return renderDocumentPdf({
    organization,
    info: { title: `${credit ? 'Credit note' : 'Tax invoice'} ${invoice.number}` },
    title: credit ? 'CREDIT NOTE' : 'TAX INVOICE',
    tag: credit ? '' : 'ORIGINAL FOR RECIPIENT',
    meta: credit
      ? [`Credit note No. ${invoice.number}`, `Date: ${day(invoice.invoiceDate)}`, `Against invoice: ${invoice.invoiceNumber}`, invoice.originalDate ? `Invoice date: ${day(invoice.originalDate)}` : '', 'Reverse charge: No']
      : [`Invoice No. ${invoice.number}`, `Date: ${day(invoice.invoiceDate)}`, invoice.orderNumber ? `Order: ${invoice.orderNumber}` : '', 'Reverse charge: No'],
    seller: invoice.seller || {},
    billTo: invoice.billTo || {},
    supply: invoice.supply || {},
    items: invoice.items || [],
    totals: invoice.totals || {},
    stateCodes: true,
    contactLines: false,
    subtotal: !credit,
    totalLabel: credit ? 'Credit total' : 'Total',
    afterTotal,
    bank: !credit && due > 0,
    payment,
    terms: credit ? '' : invoice.terms,
    notes: credit ? invoice.reason : '',
    notesTitle: 'Reason',
    watermark: !credit && invoice.status === 'credited' ? 'CREDITED' : '',
  });
}

// A receipt: who paid, how much (in words too), for which order and invoice, how, and what the
// order still owes after it.
async function renderReceiptPdf({ receipt, organization, order, seller }) {
  const logo = await logoOf(organization);
  const from = receipt.receivedFrom || {};
  const pdf = startPdf({ title: `Receipt ${receipt.number}`, author: seller.name || organization?.name || '', subject: from.name || '' });
  const { doc, text } = pdf;
  let y = drawHeader(pdf, {
    logo, seller, organization, title: 'PAYMENT RECEIPT',
    meta: [`Receipt No. ${receipt.number}`, `Date: ${day(receipt.receiptDate)}`],
  });

  y = text('RECEIVED FROM', LEFT, y, { font: 'bold', size: 7.5, color: COLOR.muted });
  y = text(from.name || '—', LEFT, y + 1, { font: 'bold', size: 10.5, width: 300 });
  const fromLines = [from.company && from.company !== from.name ? from.company : '', from.gstin ? `GSTIN: ${from.gstin}` : ''].filter(Boolean);
  if (fromLines.length) y = text(fromLines.join('\n'), LEFT, y + 1, { size: 8.5, width: 300 });
  y += 12;

  doc.roundedRect(LEFT, y, WIDTH, 62, 6).fill(COLOR.light);
  text('AMOUNT RECEIVED', LEFT + 14, y + 10, { font: 'bold', size: 7.5, color: COLOR.muted });
  text(formatRupees(receipt.amountPaise), LEFT + 14, y + 22, { font: 'bold', size: 18, width: 180 });
  text(amountInWords(receipt.amountPaise), LEFT + 200, y + 14, { size: 8.5, width: WIDTH - 214 });
  y += 76;

  const how = [receipt.source === 'link' ? 'Payment link' : '', METHODS[receipt.method] || receipt.method || ''].filter(Boolean).join(' · ');
  const rows = [
    ['Towards', [receipt.orderNumber ? `Order ${receipt.orderNumber}` : '', receipt.invoiceNumber ? `Invoice ${receipt.invoiceNumber}` : ''].filter(Boolean).join(' · ')],
    ['Paid by', how],
    ['Reference', receipt.reference],
  ];
  // What the order owes (its invoices less credit notes, once invoiced) after the payments up to
  // this one.
  const payments = order?.payments || [];
  const at = payments.findIndex((p) => String(p._id) === String(receipt.paymentId));
  if (at >= 0 && receipt.status !== 'cancelled') {
    const paidSoFar = payments.slice(0, at + 1).reduce((total, p) => total + (p.amountPaise || 0), 0);
    const total = order.totals?.grandTotalPaise || 0;
    const owed = order.billedPaise ?? total;
    rows.push([owed === total ? 'Order total' : 'Amount to pay', formatRupees(owed)], ['Paid so far', formatRupees(paidSoFar)], ['Balance due', formatRupees(Math.max(owed - paidSoFar, 0))]);
  }
  for (const [label, value] of rows.filter(([, value]) => value)) {
    text(label, LEFT, y, { size: 9, color: COLOR.muted, width: 120 });
    y = text(value, LEFT + 120, y, { size: 9, width: WIDTH - 120 }) + 4;
  }
  if (receipt.status === 'cancelled') {
    y = text(`Cancelled on ${day(receipt.cancelledAt)}: the payment was removed from the order.`, LEFT, y + 6, { size: 8.5, color: COLOR.muted, width: WIDTH });
  }
  drawSignature(pdf, y + 10, seller.name || organization?.name || '');
  return finishPdf(pdf, { watermark: receipt.status === 'cancelled' ? 'CANCELLED' : '' });
}

module.exports = { renderInvoicePdf, renderReceiptPdf, fileNameOf, dueOf };
