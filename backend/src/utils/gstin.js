// GSTIN: 2-digit state code + 10-character PAN + entity number + "Z" + check character.
const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function normalizeGstin(value) {
  return String(value || '').trim().toUpperCase();
}

function stateCodeFromGstin(value) {
  const gstin = normalizeGstin(value);
  return GSTIN_PATTERN.test(gstin) ? gstin.slice(0, 2) : '';
}

module.exports = { GSTIN_PATTERN, normalizeGstin, stateCodeFromGstin };
