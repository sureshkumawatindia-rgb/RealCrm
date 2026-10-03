const fs = require('fs/promises');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const env = require('../config/env');
const { amountInWords, formatRupees } = require('../utils/money');
const { stateName } = require('../constants/gst');
const { billingOf, fileNameFromUrl } = require('./organizationService');

// The PDF of a quotation, estimate or proforma invoice (Phase 5, D27: pdfkit). A4, Noto Sans
// (it has the ₹ sign), the organization's logo (PNG/JPEG), the customer and supply details,
// the items (the table header repeats on every page), the totals with the GST split, the
// rate-wise summary, bank details and a UPI QR code, terms, a signature line, page numbers
// and the online link. Drafts carry a "DRAFT" watermark.
const FONTS = path.resolve(__dirname, '..', '..', 'assets', 'fonts');
const MARGIN = 40;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const LEFT = MARGIN;
const RIGHT = PAGE_WIDTH - MARGIN;
const WIDTH = RIGHT - LEFT;
const CONTENT_BOTTOM = PAGE_HEIGHT - MARGIN - 22; // room for the footer
const COLOR = { text: '#1d1d1f', muted: '#6e6e73', line: '#d9d9de', head: '#fff3c4', accent: '#a37800', light: '#f6f6f8' };
// Kerning only: ligatures ("ff" in "Round off") would break copying and searching the text.
const FEATURES = { liga: false, clig: false };
const TITLE = { Quotation: 'QUOTATION', Estimate: 'ESTIMATE', 'Proforma Invoice': 'PROFORMA INVOICE' };

const num = (paise) => (Math.round(Number(paise) || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const day = (value, timeZone = 'Asia/Kolkata') => (value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone }) : '');

// NPCI's UPI link: upi://pay?pa=<UPI ID>&pn=<payee>&am=<amount>&cu=INR&tn=<note>. The UPI ID is
// validated in the billing settings (letters, digits, . _ - and @), so it is used as it is.
function upiLink({ upiId, payee, amountPaise, note }) {
  const parts = [`pa=${upiId}`, `pn=${encodeURIComponent(String(payee || upiId).slice(0, 50))}`];
  if (amountPaise) parts.push(`am=${(amountPaise / 100).toFixed(2)}`);
  parts.push('cu=INR');
  if (note) parts.push(`tn=${encodeURIComponent(String(note).slice(0, 50))}`);
  return `upi://pay?${parts.join('&')}`;
}

// The payment QR asks for the full amount on a proforma invoice (a request to pay); on a
// quotation or estimate the customer types the agreed amount (often an advance).
function paymentFor(quotation, organization) {
  const billing = billingOf(organization);
  if (!billing.upiId) return null;
  const fixed = quotation.type === 'Proforma Invoice';
  return {
    upiId: billing.upiId,
    amountPaise: fixed ? quotation.totals?.grandTotalPaise : 0,
    link: upiLink({ upiId: billing.upiId, payee: billing.bank.accountName || organization?.name, amountPaise: fixed ? quotation.totals?.grandTotalPaise : 0, note: quotation.number }),
  };
}

// The organization's logo file, if it is a PNG or JPEG (pdfkit draws only those).
async function logoOf(organization) {
  const fileName = fileNameFromUrl(organization?.logoUrl || '');
  if (!fileName) return null;
  try {
    const bytes = await fs.readFile(path.resolve(env.uploadDir, path.basename(fileName)));
    const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    return png || jpeg ? bytes : null;
  } catch {
    return null;
  }
}

function fileNameOf(quotation) {
  return `${String(quotation.number).replace(/[^A-Za-z0-9-]+/g, '-')}${quotation.revision ? `-R${quotation.revision}` : ''}.pdf`;
}

async function renderQuotationPdf({ quotation: q, organization, shareUrl }) {
  const seller = q.seller || {};
  const billTo = q.billTo || {};
  const supply = q.supply || {};
  const totals = q.totals || {};
  const items = q.items || [];
  const billing = billingOf(organization);
  const logo = await logoOf(organization);
  const payment = paymentFor(q, organization);
  const qr = payment ? await QRCode.toBuffer(payment.link, { type: 'png', margin: 1, width: 300, errorCorrectionLevel: 'M' }) : null;

  const doc = new PDFDocument({
    size: 'A4', margin: MARGIN, bufferPages: true,
    info: { Title: `${q.type} ${q.number}`, Author: seller.name || organization?.name || '', Subject: billTo.name || '' },
  });
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
  const hr = (y, color = COLOR.line) => doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.6).strokeColor(color).stroke();
  const heightOf = (value, width, { font = 'body', size = 9 } = {}) => doc.font(font).fontSize(size).heightOfString(String(value ?? ''), { width, lineGap: 1, features: FEATURES });
  const ensure = (y, needed) => {
    if (y + needed <= CONTENT_BOTTOM) return y;
    doc.addPage();
    return MARGIN;
  };

  // --- header: logo and seller (left), title and numbers (right) ---
  let y = MARGIN;
  let sellerX = LEFT;
  let logoBottom = y;
  if (logo) {
    try {
      doc.image(logo, LEFT, y, { fit: [110, 56] });
      sellerX = LEFT + 122;
      logoBottom = y + 56;
    } catch {
      /* a broken logo file is left out */
    }
  }
  const sellerWidth = 330 - sellerX;
  let leftY = text(seller.name || organization?.name || '', sellerX, y, { font: 'bold', size: 14, width: sellerWidth });
  const sellerLines = [
    seller.address,
    [seller.city, seller.state, seller.postalCode].filter(Boolean).join(', '),
    seller.gstin ? `GSTIN: ${seller.gstin}` : '',
    [seller.phone, seller.email].filter(Boolean).join('  ·  '),
  ].filter(Boolean);
  if (sellerLines.length) leftY = text(sellerLines.join('\n'), sellerX, leftY + 2, { size: 8.5, color: COLOR.muted, width: sellerWidth });

  let rightY = text(TITLE[q.type] || 'QUOTATION', 340, y, { font: 'bold', size: 16, color: COLOR.accent, width: RIGHT - 340, align: 'right' });
  const meta = [
    `No. ${q.number}${q.revision ? `  (revision ${q.revision})` : ''}`,
    `Date: ${day(q.quotationDate)}`,
    q.validUntil ? `Valid until: ${day(q.validUntil, 'UTC')}` : '',
  ].filter(Boolean);
  rightY = text(meta.join('\n'), 340, rightY + 2, { size: 9, width: RIGHT - 340, align: 'right' });
  y = Math.max(leftY, rightY, logoBottom) + 10;
  hr(y);
  y += 10;

  // --- the customer (left) and the supply (right) ---
  const blockTop = y;
  leftY = text('BILL TO', LEFT, y, { font: 'bold', size: 7.5, color: COLOR.muted });
  leftY = text(billTo.name || '—', LEFT, leftY + 1, { font: 'bold', size: 10.5, width: 300 });
  const billLines = [
    billTo.company && billTo.company !== billTo.name ? billTo.company : '',
    billTo.address,
    [billTo.city, billTo.state || stateName(billTo.stateCode), billTo.postalCode].filter(Boolean).join(', '),
    billTo.gstin ? `GSTIN: ${billTo.gstin}` : '',
    [billTo.phone, billTo.email].filter(Boolean).join('  ·  '),
  ].filter(Boolean);
  if (billLines.length) leftY = text(billLines.join('\n'), LEFT, leftY + 1, { size: 8.5, width: 300 });

  const place = supply.placeOfSupplyCode ? `${stateName(supply.placeOfSupplyCode)} (${supply.placeOfSupplyCode})` : '—';
  const supplyKind = supply.zeroRated
    ? 'Export / SEZ under LUT (no GST)'
    : supply.interState ? 'Between states (IGST)' : `Within the state (CGST + ${supply.taxLabel || 'SGST'})`;
  rightY = text('PLACE OF SUPPLY', 360, blockTop, { font: 'bold', size: 7.5, color: COLOR.muted, width: RIGHT - 360, align: 'right' });
  rightY = text(place, 360, rightY + 1, { font: 'bold', size: 10, width: RIGHT - 360, align: 'right' });
  rightY = text(supplyKind, 360, rightY + 1, { size: 8.5, color: COLOR.muted, width: RIGHT - 360, align: 'right' });
  if (supply.stateAssumed) rightY = text('Customer\'s state not known: seller\'s state assumed', 360, rightY + 1, { size: 7.5, color: COLOR.muted, width: RIGHT - 360, align: 'right' });
  y = Math.max(leftY, rightY) + 12;

  // --- items ---
  const columns = [
    { title: '#', width: 18 },
    { title: 'Item', width: 140 },
    { title: 'HSN/SAC', width: 42 },
    { title: 'Qty', width: 48, align: 'right' },
    { title: 'Rate', width: 60, align: 'right' },
    { title: 'Discount', width: 50, align: 'right' },
    { title: 'Taxable', width: 62, align: 'right' },
    { title: 'GST', width: 30, align: 'right' },
    { title: 'Amount', width: WIDTH - 450, align: 'right' },
  ];
  const PAD = 4;
  const drawHead = (top) => {
    doc.rect(LEFT, top, WIDTH, 18).fill(COLOR.head);
    let x = LEFT;
    for (const column of columns) {
      text(column.title.toUpperCase(), x + PAD, top + 5, { font: 'bold', size: 7, width: column.width - PAD * 2, align: column.align || 'left' });
      x += column.width;
    }
    return top + 18;
  };
  y = drawHead(ensure(y, 60));
  items.forEach((item, index) => {
    const description = item.description ? String(item.description) : '';
    const itemWidth = columns[1].width - PAD * 2;
    const height = Math.max(heightOf(item.name, itemWidth, { font: 'bold', size: 8.5 }) + (description ? heightOf(description, itemWidth, { size: 7.5 }) + 1 : 0), 11) + PAD * 2;
    if (y + height > CONTENT_BOTTOM) {
      doc.addPage();
      y = drawHead(MARGIN);
    }
    const discount = item.discountPaise ? (item.discountType === 'percent' ? `${qty(item.discountValue)}%` : num(item.discountPaise)) : '—';
    const cells = [
      String(index + 1), null, item.hsnSac || '', `${qty(item.quantity)}${item.unit ? ` ${item.unit}` : ''}`, num(item.unitPricePaise),
      discount, num(item.taxablePaise), `${qty(item.gstRatePct)}%`, num(item.totalPaise),
    ];
    let x = LEFT;
    columns.forEach((column, i) => {
      if (i === 1) {
        const after = text(item.name, x + PAD, y + PAD, { font: 'bold', size: 8.5, width: itemWidth });
        if (description) text(description, x + PAD, after + 1, { size: 7.5, color: COLOR.muted, width: itemWidth });
      } else {
        text(cells[i], x + PAD, y + PAD, { size: 8.5, width: column.width - PAD * 2, align: column.align || 'left' });
      }
      x += column.width;
    });
    y += height;
    doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.4).strokeColor(COLOR.line).stroke();
  });

  // --- totals (right) and the amount in words with the GST summary (left) ---
  const totalRows = [
    ['Subtotal', num(totals.subtotalPaise)],
    ...(totals.discountPaise ? [['Discount', `− ${num(totals.discountPaise)}`]] : []),
    ['Taxable value', num(totals.taxablePaise)],
    ...(supply.zeroRated ? [['GST', 'Nil (LUT)']] : supply.interState ? [['IGST', num(totals.igstPaise)]] : [['CGST', num(totals.cgstPaise)], [supply.taxLabel || 'SGST', num(totals.sgstPaise)]]),
    ...(totals.roundOffPaise ? [['Round off', `${totals.roundOffPaise > 0 ? '+' : '−'} ${num(Math.abs(totals.roundOffPaise))}`]] : []),
  ];
  const rates = (totals.byRate || []).filter((r) => r.taxablePaise);
  const blockHeight = Math.max(totalRows.length * 14 + 30, 40 + rates.length * 12 + 30);
  y = ensure(y + 10, blockHeight);
  const totalsX = RIGHT - 220;
  let ty = y;
  for (const [label, value] of totalRows) {
    text(label, totalsX, ty, { size: 9, color: COLOR.muted, width: 110 });
    text(value, totalsX + 110, ty, { size: 9, width: 110, align: 'right' });
    ty += 14;
  }
  doc.moveTo(totalsX, ty + 1).lineTo(RIGHT, ty + 1).lineWidth(0.8).strokeColor(COLOR.text).stroke();
  text('Total', totalsX, ty + 5, { font: 'bold', size: 11, width: 90 });
  ty = text(formatRupees(totals.grandTotalPaise), totalsX + 90, ty + 5, { font: 'bold', size: 11, width: 130, align: 'right' });

  let ly = text('Amount in words', LEFT, y, { font: 'bold', size: 7.5, color: COLOR.muted });
  ly = text(amountInWords(totals.grandTotalPaise), LEFT, ly + 1, { size: 8.5, width: 260 });
  if (rates.length) {
    ly += 8;
    const rateColumns = supply.interState
      ? [['GST rate', 60], ['Taxable', 100], ['IGST', 100]]
      : [['GST rate', 50], ['Taxable', 75], ['CGST', 65], [supply.taxLabel || 'SGST', 65]];
    let rx = LEFT;
    for (const [title, width] of rateColumns) {
      text(title, rx, ly, { font: 'bold', size: 7, color: COLOR.muted, width: width - 4, align: rx === LEFT ? 'left' : 'right' });
      rx += width;
    }
    ly += 11;
    for (const rate of rates) {
      const values = supply.interState
        ? [`${qty(rate.ratePct)}%`, num(rate.taxablePaise), num(rate.igstPaise)]
        : [`${qty(rate.ratePct)}%`, num(rate.taxablePaise), num(rate.cgstPaise), num(rate.sgstPaise)];
      rx = LEFT;
      values.forEach((value, i) => {
        text(value, rx, ly, { size: 7.5, width: rateColumns[i][1] - 4, align: i === 0 ? 'left' : 'right' });
        rx += rateColumns[i][1];
      });
      ly += 11;
    }
  }
  y = Math.max(ty, ly) + 8;
  if (supply.zeroRated) {
    y = text('Supply meant for export / supply to SEZ under LUT without payment of integrated tax.', LEFT, y, { size: 8, color: COLOR.muted, width: WIDTH }) + 4;
  }

  // --- bank details and the UPI QR code ---
  const bank = billing.bank || {};
  const bankLines = [
    bank.accountName ? `Account name: ${bank.accountName}` : '',
    bank.accountNumber ? `Account number: ${bank.accountNumber}` : '',
    bank.ifsc ? `IFSC: ${bank.ifsc}` : '',
    [bank.bankName, bank.branch].filter(Boolean).join(', '),
    payment ? `UPI: ${payment.upiId}` : '',
  ].filter(Boolean);
  if (bankLines.length || qr) {
    const boxHeight = Math.max(bankLines.length * 12 + 26, qr ? 100 : 0);
    y = ensure(y + 6, boxHeight + 4);
    doc.roundedRect(LEFT, y, WIDTH, boxHeight, 6).fill(COLOR.light);
    let by = text('PAYMENT DETAILS', LEFT + 12, y + 9, { font: 'bold', size: 7.5, color: COLOR.muted });
    if (bankLines.length) text(bankLines.join('\n'), LEFT + 12, by + 2, { size: 8.5, width: 300 });
    if (qr) {
      doc.image(qr, RIGHT - 92, y + 8, { width: 80, height: 80 });
      text(payment.amountPaise ? `Scan to pay ${formatRupees(payment.amountPaise)}` : 'Scan to pay with any UPI app', RIGHT - 240, y + 40, { size: 8, color: COLOR.muted, width: 140, align: 'right' });
    }
    y += boxHeight + 10;
  }

  // --- terms, notes and the signature ---
  if (q.terms) {
    y = ensure(y, 40);
    y = text('Terms and conditions', LEFT, y, { font: 'bold', size: 9 });
    y = text(q.terms, LEFT, y + 2, { size: 8.5, color: COLOR.text, width: WIDTH }) + 8;
  }
  if (q.notes) {
    y = ensure(y, 30);
    y = text('Note', LEFT, y, { font: 'bold', size: 9 });
    y = text(q.notes, LEFT, y + 2, { size: 8.5, width: WIDTH }) + 8;
  }
  y = ensure(y + 6, 54);
  text(`For ${seller.name || organization?.name || ''}`, RIGHT - 220, y, { font: 'bold', size: 9, width: 220, align: 'right' });
  text('Authorised signatory', RIGHT - 220, y + 38, { size: 8, color: COLOR.muted, width: 220, align: 'right' });

  // --- on every page: the footer, and "DRAFT" across a draft ---
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing in the margin must not open a new page
    const footerY = PAGE_HEIGHT - MARGIN + 6;
    doc.moveTo(LEFT, footerY - 6).lineTo(RIGHT, footerY - 6).lineWidth(0.4).strokeColor(COLOR.line).stroke();
    if (shareUrl) {
      doc.font('body').fontSize(7).fillColor(COLOR.muted).text('View online: ', LEFT, footerY, { continued: true, lineBreak: false })
        .fillColor(COLOR.accent).text(shareUrl, { link: shareUrl, underline: false, lineBreak: false });
    } else {
      text('This is a computer-generated document.', LEFT, footerY, { size: 7, color: COLOR.muted, lineBreak: false });
    }
    text(`Page ${i - range.start + 1} of ${range.count}`, RIGHT - 100, footerY, { size: 7, color: COLOR.muted, width: 100, align: 'right', lineBreak: false });
    if (q.status === 'Draft') {
      doc.save();
      doc.rotate(-35, { origin: [PAGE_WIDTH / 2, PAGE_HEIGHT / 2] });
      doc.font('bold').fontSize(96).fillColor('#c8c8cc').fillOpacity(0.25)
        .text('DRAFT', 0, PAGE_HEIGHT / 2 - 60, { width: PAGE_WIDTH, align: 'center', lineBreak: false });
      doc.restore();
      doc.fillOpacity(1);
    }
    doc.page.margins.bottom = bottomMargin;
  }

  doc.end();
  return finished;
}

module.exports = { renderQuotationPdf, upiLink, paymentFor, fileNameOf, logoOf };
