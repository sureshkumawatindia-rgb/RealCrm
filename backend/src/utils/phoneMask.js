// Customers' phone numbers hidden from agents and viewers (D65, Settings → Team & Access → "Hide
// customer phone numbers from agents"). The server masks every answer it gives them; it keeps the
// real numbers for sending messages, quotations and payment links.

const BULLET = '•';

// Keys whose value is a customer's (or a contact's) number wherever they appear in an answer.
const PHONE_KEYS = new Set([
  'phone', 'phoneE164', 'mobile', 'whatsapp', 'waId', 'wa_id', 'phoneNumber', 'customerPhone', 'contactPhone', 'from', 'to',
]);
// The company's own numbers: its WhatsApp number on a chat, the seller on a quotation or order.
const COMPANY_KEYS = new Set(['displayPhone', 'seller']);
// Keys that show a name, which is the number itself for a contact nobody has named yet.
const NAME_KEYS = new Set(['name', 'title', 'contactName', 'customerName', 'relatedName', 'displayName', 'label']);

const digitsOf = (value) => String(value ?? '').replace(/\D/g, '');
// The whole value is a phone number: digits with +, spaces, dashes, dots or brackets only.
const isPhoneText = (value) => typeof value === 'string' && /^[+\d\s().-]+$/.test(value.trim()) && digitsOf(value).length >= 10 && digitsOf(value).length <= 15;
// A number written with a + inside a longer text ("New lead from +91 98765 43210").
const PLUS_NUMBER = /\+\d[\d\s().-]{8,18}\d/g;

// "+919876543210" → "+91 98••• ••210"; "98765 43210" → "98••• ••210". Too short to be a number:
// unchanged.
function maskPhone(value) {
  const text = String(value ?? '');
  if (text.includes(BULLET)) return text;
  const digits = digitsOf(text);
  if (digits.length < 7) return text;
  const national = digits.length > 10 ? digits.slice(-10) : digits;
  const country = digits.length > 10 ? digits.slice(0, digits.length - 10) : '';
  const hidden = national.length - 5;
  const first = Math.min(3, hidden);
  const masked = `${national.slice(0, 2)}${BULLET.repeat(first)}${hidden > first ? ` ${BULLET.repeat(hidden - first)}` : ''}${national.slice(-3)}`;
  return country ? `+${country} ${masked}` : `${text.trim().startsWith('+') ? '+' : ''}${masked}`;
}

function maskText(text) {
  return text.replace(PLUS_NUMBER, (match) => maskPhone(match));
}

// A copy of an API answer with every customer number masked.
function maskPhonesIn(value, key = '') {
  if (COMPANY_KEYS.has(key)) return value;
  if (typeof value === 'string') {
    if (PHONE_KEYS.has(key) || (NAME_KEYS.has(key) && isPhoneText(value))) return maskPhone(value);
    return value.includes('+') ? maskText(value) : value;
  }
  if (Array.isArray(value)) return value.map((item) => maskPhonesIn(item, key));
  if (value && typeof value === 'object') {
    if (value instanceof Date || Buffer.isBuffer(value)) return value;
    if (typeof value.toJSON === 'function' && !Array.isArray(value)) {
      const plain = value.toJSON();
      if (plain !== value) return maskPhonesIn(plain, key);
    }
    const copy = {};
    for (const [field, item] of Object.entries(value)) copy[field] = maskPhonesIn(item, field);
    return copy;
  }
  return value;
}

// A masked number sent back (an agent saved a form that showed it) is never a new number: it
// is dropped from the request, so the real one stays.
function stripMaskedPhones(body) {
  if (Array.isArray(body)) {
    body.forEach(stripMaskedPhones);
    return body;
  }
  if (!body || typeof body !== 'object') return body;
  for (const [field, item] of Object.entries(body)) {
    if (typeof item === 'string' && item.includes(BULLET) && (PHONE_KEYS.has(field) || NAME_KEYS.has(field))) delete body[field];
    else if (item && typeof item === 'object') stripMaskedPhones(item);
  }
  return body;
}

module.exports = { maskPhone, maskPhonesIn, stripMaskedPhones, isPhoneText, BULLET };
