const path = require('path');
const PDFDocument = require('pdfkit');
const { amountInWords } = require('../utils/money');
const { stateName } = require('../constants/gst');

// The PDF of a plan's GST tax invoice (Phase 10B): the platform to the organization, one paid
// month, SAC, taxable value, CGST + SGST (same state) or IGST, the total in words, and the
// gateway payment it was paid with. A4, Noto Sans (it has the ₹ sign), like the quotations.
const FONTS = path.resolve(__dirname, '..', '..', 'assets', 'fonts');
const MARGIN = 40;
const LEFT = MARGIN;
const RIGHT = 595.28 - MARGIN;
const WIDTH = RIGHT - LEFT;
const COLOR = { text: '#1d1d1f', muted: '#6e6e73', line: '#d9d9de', head: '#fff3c4' };
const FEATURES = { liga: false, clig: false };

const num = (paise) => (Math.round(Number(paise) || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (value) => (value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');

function render(invoice) {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: `Tax invoice ${invoice.number}`, Author: invoice.seller?.name || '', Subject: invoice.buyer?.name || '' } });
  doc.registerFont('body', path.join(FONTS, 'NotoSans-Regular.ttf'));
  doc.registerFont('bold', path.join(FONTS, 'NotoSans-Bold.ttf'));
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const text = (value, x, y, options = {}) => {
    const { font = 'body', size = 9, color = COLOR.text, ...rest } = options;
    doc.font(font).fontSize(size).fillColor(color).text(String(value ?? ''), x, y, { lineGap: 1, features: FEATURES, ...rest });
    return doc.y;
  };
  const line = (y) => doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.6).strokeColor(COLOR.line).stroke();
  const seller = invoice.seller || {};
  const buyer = invoice.buyer || {};

  // Heading: who issues it, and the invoice's number and date.
  text('TAX INVOICE', LEFT, MARGIN, { font: 'bold', size: 16 });
  let y = text(seller.name || '', LEFT, MARGIN + 26, { font: 'bold', size: 11, width: WIDTH / 2 });
  if (seller.address) y = text(seller.address, LEFT, y + 2, { width: WIDTH / 2, color: COLOR.muted });
  if (seller.gstin) y = text(`GSTIN: ${seller.gstin}`, LEFT, y + 2, { width: WIDTH / 2 });
  if (seller.state) y = text(`State: ${seller.state} (${seller.stateCode})`, LEFT, y + 2, { width: WIDTH / 2 });
  if (seller.email) y = text(seller.email, LEFT, y + 2, { width: WIDTH / 2, color: COLOR.muted });
  const right = LEFT + WIDTH / 2 + 20;
  text(`Invoice no.: ${invoice.number}`, right, MARGIN + 26, { font: 'bold', size: 10, width: WIDTH / 2 - 20, align: 'right' });
  text(`Date: ${day(invoice.issuedAt)}`, right, MARGIN + 42, { width: WIDTH / 2 - 20, align: 'right' });
  text(`Place of supply: ${stateName(invoice.placeOfSupplyCode) || '—'}${invoice.placeOfSupplyCode ? ` (${invoice.placeOfSupplyCode})` : ''}`, right, MARGIN + 56, { width: WIDTH / 2 - 20, align: 'right' });
  y = Math.max(y, MARGIN + 70) + 14;
  line(y);

  // Bill to.
  y = text('BILL TO', LEFT, y + 10, { font: 'bold', size: 8, color: COLOR.muted });
  y = text(buyer.name || '', LEFT, y + 2, { font: 'bold', size: 10 });
  if (buyer.address) y = text(buyer.address, LEFT, y + 2, { width: WIDTH * 0.6, color: COLOR.muted });
  y = text(buyer.gstin ? `GSTIN: ${buyer.gstin}` : 'GSTIN: unregistered', LEFT, y + 2);
  if (buyer.state) y = text(`State: ${buyer.state} (${buyer.stateCode})`, LEFT, y + 2);
  y += 16;

  // The one line: the plan for the month, and its tax.
  const intra = invoice.igstPaise === 0 && (invoice.cgstPaise || invoice.sgstPaise);
  const cols = [
    { title: 'Description', width: 215, align: 'left' },
    { title: 'SAC', width: 50, align: 'left' },
    { title: 'Taxable value', width: 80, align: 'right' },
    ...(intra ? [{ title: 'CGST 9%', width: 55, align: 'right' }, { title: 'SGST 9%', width: 55, align: 'right' }] : [{ title: 'IGST 18%', width: 110, align: 'right' }]),
  ];
  cols.push({ title: 'Amount (₹)', width: WIDTH - cols.reduce((sum, c) => sum + c.width, 0), align: 'right' });
  doc.rect(LEFT, y, WIDTH, 20).fill(COLOR.head);
  let x = LEFT;
  for (const c of cols) {
    text(c.title, x + 4, y + 5, { font: 'bold', size: 8.5, width: c.width - 8, align: c.align });
    x += c.width;
  }
  y += 24;
  const period = invoice.periodStart && invoice.periodEnd ? `${day(invoice.periodStart)} – ${day(invoice.periodEnd)}` : 'one month';
  const values = [
    `YELLOW CRM ${invoice.planName || ''} plan, subscription for ${period}`,
    invoice.sac || '',
    num(invoice.taxablePaise),
    ...(intra ? [num(invoice.cgstPaise), num(invoice.sgstPaise)] : [num(invoice.igstPaise)]),
    num(invoice.totalPaise),
  ];
  x = LEFT;
  let rowBottom = y;
  values.forEach((value, i) => {
    rowBottom = Math.max(rowBottom, text(value, x + 4, y, { width: cols[i].width - 8, align: cols[i].align }));
    x += cols[i].width;
  });
  y = rowBottom + 8;
  line(y);

  // Totals.
  const totals = [
    ['Taxable value', num(invoice.taxablePaise)],
    ...(intra ? [['CGST 9%', num(invoice.cgstPaise)], ['SGST 9%', num(invoice.sgstPaise)]] : [['IGST 18%', num(invoice.igstPaise)]]),
    ['Total (₹)', num(invoice.totalPaise)],
  ];
  y += 8;
  totals.forEach(([label, value], i) => {
    const bold = i === totals.length - 1;
    text(label, RIGHT - 230, y, { font: bold ? 'bold' : 'body', size: bold ? 10.5 : 9, width: 140, align: 'right' });
    text(value, RIGHT - 90, y, { font: bold ? 'bold' : 'body', size: bold ? 10.5 : 9, width: 90, align: 'right' });
    y += bold ? 18 : 14;
  });
  y = text(`Amount in words: ${amountInWords(invoice.totalPaise)}`, LEFT, y + 6, { width: WIDTH });
  y = text(`Paid online${invoice.providerPaymentId ? ` (payment ${invoice.providerPaymentId})` : ''}. Tax payable on reverse charge: No.`, LEFT, y + 6, { width: WIDTH, color: COLOR.muted });
  text('This is a computer-generated invoice and needs no signature.', LEFT, y + 18, { size: 8, color: COLOR.muted, width: WIDTH });
  doc.end();
  return finished;
}

module.exports = { render };
