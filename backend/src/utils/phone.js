// Normalizes a phone number to E.164 (+<country><number>). Numbers without a country code
// are treated as Indian (+91). Returns '' for an empty input and null when it cannot be a phone.
function normalizePhone(raw, defaultCountryCode = '91') {
  const input = String(raw ?? '').trim();
  if (!input) return '';

  let digits = input.replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  const hasPlus = digits.startsWith('+');
  digits = digits.replace(/\+/g, '');

  let e164;
  if (hasPlus) {
    e164 = digits;
  } else if (digits.length === 10) {
    e164 = defaultCountryCode + digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    e164 = defaultCountryCode + digits.slice(1);
  } else if (digits.length === 12 && digits.startsWith(defaultCountryCode)) {
    e164 = digits;
  } else {
    return null;
  }

  if (!/^[1-9]\d{7,14}$/.test(e164)) return null;
  // Indian mobile and landline numbers have 10 digits after +91.
  if (e164.startsWith('91') && e164.length !== 12) return null;
  return `+${e164}`;
}

module.exports = { normalizePhone };
