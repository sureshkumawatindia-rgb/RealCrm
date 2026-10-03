// Money is stored as integer paise (D1). These helpers are for importing old browser data,
// which kept rupees as strings or numbers.
function rupeesToPaise(value) {
  if (value === '' || value == null) return null;
  const number = Number(String(value).replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * 100);
}

// Indian financial year label for a date (April–March), e.g. 2026-09-24 → "2026-27".
function financialYear(date = new Date()) {
  const india = new Date(date.getTime() + 330 * 60 * 1000); // IST calendar date
  const year = india.getUTCFullYear();
  const start = india.getUTCMonth() >= 3 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

// ₹1,27,130.50 written out the Indian way (lakh, crore): "Rupees One Lakh Twenty-Seven Thousand
// One Hundred Thirty and Fifty Paise Only". Quotations and invoices print it under the total.
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const belowHundred = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
const belowThousand = (n) => [Math.floor(n / 100) ? `${ONES[Math.floor(n / 100)]} Hundred` : '', n % 100 ? belowHundred(n % 100) : ''].filter(Boolean).join(' ');

function rupeeWords(rupees) {
  const parts = [];
  let rest = rupees;
  for (const [size, name] of [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']]) {
    const count = Math.floor(rest / size);
    if (count) parts.push(`${count >= 1000 ? rupeeWords(count) : belowThousand(count)} ${name}`);
    rest %= size;
  }
  if (rest) parts.push(belowThousand(rest));
  return parts.join(' ');
}

function amountInWords(paise) {
  const total = Math.max(Math.round(Number(paise) || 0), 0);
  const rupees = Math.floor(total / 100);
  const rest = total % 100;
  return `Rupees ${rupees ? rupeeWords(rupees) : 'Zero'}${rest ? ` and ${belowHundred(rest)} Paise` : ''} Only`;
}

// ₹12,34,567.50 (Indian digit grouping).
const formatRupees = (paise, { symbol = '₹' } = {}) => `${symbol}${(Math.round(Number(paise) || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

module.exports = { rupeesToPaise, financialYear, amountInWords, formatRupees };
