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

module.exports = { rupeesToPaise, financialYear };
