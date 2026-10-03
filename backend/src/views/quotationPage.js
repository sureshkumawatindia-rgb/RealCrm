const fs = require('fs/promises');
const path = require('path');
const QRCode = require('qrcode');
const env = require('../config/env');
const { amountInWords, formatRupees } = require('../utils/money');
const { stateName } = require('../constants/gst');
const { billingOf, fileNameFromUrl } = require('../services/organizationService');
const { paymentFor } = require('../services/quotationPdf');

// The page a customer sees at /q/<signed link> (Phase 5): the quotation on any phone, with a
// UPI "pay" button and QR code, and the PDF. Plain HTML and inline CSS only: the route sends a
// strict Content-Security-Policy (no scripts at all). Every value from the database is escaped.
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (paise) => (Math.round(Number(paise) || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const day = (value, timeZone = 'Asia/Kolkata') => (value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone }) : '');

const STYLE = `
  :root { --brand: #ffde59; --ink: #1d1d1f; --muted: #6e6e73; --line: #e6e6ea; --bg: #f6f6f8; --ok: #1fa971; --warn: #b26a00; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif; }
  main { max-width: 820px; margin: 0 auto; padding: 16px; }
  .card { background: #fff; border-radius: 16px; padding: 20px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  header.card { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; border-top: 6px solid var(--brand); }
  .seller { display: flex; gap: 14px; align-items: flex-start; min-width: 0; }
  .seller img { max-width: 96px; max-height: 56px; object-fit: contain; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; }
  .muted { color: var(--muted); font-size: 13px; }
  .doc { text-align: right; }
  .doc .type { font-weight: 700; letter-spacing: .08em; color: #a37800; }
  .doc .no { font-size: 18px; font-weight: 700; }
  .banner { border-radius: 12px; padding: 10px 14px; margin-bottom: 14px; font-size: 14px; }
  .banner.ok { background: #eaf8f2; color: #0f6b46; }
  .banner.warn { background: #fff4e5; color: var(--warn); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .item { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
  .item:last-child { border-bottom: 0; }
  .item .name { font-weight: 600; }
  .item .amount { font-weight: 600; white-space: nowrap; text-align: right; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-variant-numeric: tabular-nums; }
  .row.grand { border-top: 2px solid var(--ink); margin-top: 8px; padding-top: 10px; font-size: 20px; font-weight: 700; }
  .pay { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
  .pay img { width: 150px; height: 150px; }
  .btn { display: inline-block; padding: 12px 18px; border-radius: 999px; background: var(--brand); color: var(--ink); font-weight: 700; text-decoration: none; margin: 6px 8px 0 0; }
  .btn.outline { background: #fff; border: 1.5px solid var(--line); }
  pre { white-space: pre-wrap; font: inherit; margin: 0; }
  footer { text-align: center; color: var(--muted); font-size: 12px; padding: 8px 0 24px; }
  @media (max-width: 600px) { .grid2 { grid-template-columns: 1fr; } .doc { text-align: left; } main { padding: 10px; } .card { padding: 16px; } }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function notFoundPage() {
  return page('Not found', '<div class="card"><h1>This link does not work</h1><p class="muted">The quotation may have been withdrawn. Please ask the sender for a new link.</p></div>');
}

// The logo as a data: URL, so it shows wherever the page is opened (no other address involved).
async function logoDataUrl(organization) {
  const fileName = fileNameFromUrl(organization?.logoUrl || '');
  if (!fileName) return '';
  const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
  const type = types[path.extname(fileName).slice(1).toLowerCase()];
  if (!type) return '';
  try {
    const bytes = await fs.readFile(path.resolve(env.uploadDir, path.basename(fileName)));
    return bytes.length <= 2 * 1024 * 1024 ? `data:${type};base64,${bytes.toString('base64')}` : '';
  } catch {
    return '';
  }
}

function draftPage(quotation, seller) {
  return page(`${quotation.type} ${quotation.number}`, `
    <div class="card"><h1>${esc(seller.name)}</h1>
    <p>This ${esc(quotation.type.toLowerCase())} is being updated. Please ask ${esc(seller.name || 'the sender')} for the latest copy${seller.phone ? ` (${esc(seller.phone)})` : ''}.</p></div>`);
}

async function quotationPage({ quotation: q, organization, token }) {
  const seller = q.seller || {};
  if (q.status === 'Draft') return draftPage(q, seller);
  const billTo = q.billTo || {};
  const supply = q.supply || {};
  const totals = q.totals || {};
  const billing = billingOf(organization);
  const logo = await logoDataUrl(organization);
  const payment = paymentFor(q, organization);
  const qr = payment ? await QRCode.toDataURL(payment.link, { margin: 1, width: 300, errorCorrectionLevel: 'M' }) : '';
  const expired = q.status === 'Expired' || (q.validUntil && new Date(q.validUntil) < new Date(new Date().toISOString().slice(0, 10)) && ['Sent', 'Viewed'].includes(q.status));
  const banner = q.status === 'Accepted'
    ? '<div class="banner ok">Accepted — thank you!</div>'
    : q.status === 'Rejected' ? '<div class="banner warn">This quotation was closed.</div>'
      : expired ? `<div class="banner warn">This quotation was valid until ${esc(day(q.validUntil, 'UTC'))}. Please ask for an updated one.</div>` : '';

  const rupees = (paise) => `₹${num(paise)}`;
  const rows = [
    ['Subtotal', rupees(totals.subtotalPaise)],
    ...(totals.discountPaise ? [['Discount', `− ${rupees(totals.discountPaise)}`]] : []),
    ['Taxable value', rupees(totals.taxablePaise)],
    ...(supply.zeroRated ? [['GST', 'Nil (LUT)']] : supply.interState ? [['IGST', rupees(totals.igstPaise)]] : [['CGST', rupees(totals.cgstPaise)], [supply.taxLabel || 'SGST', rupees(totals.sgstPaise)]]),
    ...(totals.roundOffPaise ? [['Round off', `${totals.roundOffPaise > 0 ? '+' : '−'} ${rupees(Math.abs(totals.roundOffPaise))}`]] : []),
  ];
  const bank = billing.bank || {};
  const bankLines = [
    bank.accountName ? `Account name: ${bank.accountName}` : '',
    bank.accountNumber ? `Account number: ${bank.accountNumber}` : '',
    bank.ifsc ? `IFSC: ${bank.ifsc}` : '',
    [bank.bankName, bank.branch].filter(Boolean).join(', '),
  ].filter(Boolean);

  return page(`${q.type} ${q.number} — ${seller.name || ''}`, `
    <header class="card">
      <div class="seller">
        ${logo ? `<img src="${logo}" alt="">` : ''}
        <div><h1>${esc(seller.name)}</h1>
          <div class="muted">${[seller.address, [seller.city, seller.state].filter(Boolean).join(', '), seller.gstin ? `GSTIN ${seller.gstin}` : '', seller.phone].filter(Boolean).map(esc).join('<br>')}</div>
        </div>
      </div>
      <div class="doc">
        <div class="type">${esc(q.type.toUpperCase())}</div>
        <div class="no">${esc(q.number)}</div>
        <div class="muted">${esc(day(q.quotationDate))}${q.validUntil ? ` · valid until ${esc(day(q.validUntil, 'UTC'))}` : ''}${q.revision ? ` · revision ${q.revision}` : ''}</div>
      </div>
    </header>
    ${banner}
    <section class="card grid2">
      <div><h2>For</h2><strong>${esc(billTo.name)}</strong>
        <div class="muted">${[billTo.company && billTo.company !== billTo.name ? billTo.company : '', billTo.address, [billTo.city, billTo.state || stateName(billTo.stateCode)].filter(Boolean).join(', '), billTo.gstin ? `GSTIN ${billTo.gstin}` : ''].filter(Boolean).map(esc).join('<br>')}</div>
      </div>
      <div><h2>Place of supply</h2>${esc(stateName(supply.placeOfSupplyCode) || '—')}
        <div class="muted">${supply.zeroRated ? 'Export / SEZ under LUT (no GST)' : supply.interState ? 'IGST' : `CGST + ${esc(supply.taxLabel || 'SGST')}`}</div>
      </div>
    </section>
    <section class="card">
      <h2>Items</h2>
      ${(q.items || []).map((item) => `
        <div class="item">
          <div><div class="name">${esc(item.name)}</div>
            <div class="muted">${esc(qty(item.quantity))}${item.unit ? ` ${esc(item.unit)}` : ''} × ₹${num(item.unitPricePaise)}${item.discountPaise ? ` − ${item.discountType === 'percent' ? `${esc(qty(item.discountValue))}%` : `₹${num(item.discountPaise)}`}` : ''} · GST ${esc(qty(item.gstRatePct))}%${item.hsnSac ? ` · HSN ${esc(item.hsnSac)}` : ''}</div>
            ${item.description ? `<div class="muted">${esc(item.description)}</div>` : ''}
          </div>
          <div class="amount">₹${num(item.totalPaise)}</div>
        </div>`).join('')}
    </section>
    <section class="card">
      ${rows.map(([label, value]) => `<div class="row"><span class="muted">${esc(label)}</span><span>${esc(value)}</span></div>`).join('')}
      <div class="row grand"><span>Total</span><span>${esc(formatRupees(totals.grandTotalPaise))}</span></div>
      <div class="muted">${esc(amountInWords(totals.grandTotalPaise))}</div>
    </section>
    ${payment || bankLines.length ? `
    <section class="card"><h2>Payment</h2>
      <div class="pay">
        ${qr ? `<img src="${qr}" alt="UPI QR code">` : ''}
        <div>${bankLines.map(esc).join('<br>')}${payment ? `${bankLines.length ? '<br>' : ''}UPI: <strong>${esc(payment.upiId)}</strong>` : ''}
          ${payment ? `<div><a class="btn" href="${esc(payment.link)}">Pay with UPI${payment.amountPaise ? ` ${esc(formatRupees(payment.amountPaise))}` : ''}</a></div>` : ''}
        </div>
      </div>
    </section>` : ''}
    ${q.terms ? `<section class="card"><h2>Terms and conditions</h2><pre>${esc(q.terms)}</pre></section>` : ''}
    ${q.notes ? `<section class="card"><h2>Note</h2><pre>${esc(q.notes)}</pre></section>` : ''}
    <div><a class="btn" href="/q/${esc(token)}/pdf">Download PDF</a>${seller.phone ? `<a class="btn outline" href="tel:${esc(String(seller.phone).replace(/[^+\d]/g, ''))}">Call ${esc(seller.name || '')}</a>` : ''}</div>
    <footer>${esc(seller.name)}${seller.email ? ` · ${esc(seller.email)}` : ''}</footer>`);
}

module.exports = { quotationPage, notFoundPage };
