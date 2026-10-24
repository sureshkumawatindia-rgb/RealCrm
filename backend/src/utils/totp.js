const crypto = require('crypto');

// Time-based one-time codes (RFC 6238, the codes Google Authenticator and similar apps show),
// without a library (F7). HMAC-SHA1, 30-second steps, 6 digits; checked against the RFC's own
// test values (tests/totp.test.js).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Not a base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// The code for one counter value (RFC 4226).
function hotp(secret, counter, digits = 6) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = crypto.createHmac('sha1', secret).update(message).digest();
  const offset = hash[hash.length - 1] & 15;
  const number = (hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(number).padStart(digits, '0');
}

const stepAt = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);
const codeAt = (secret, ms, digits = 6) => hotp(secret, stepAt(ms), digits);

// The step the code belongs to (now, or one step either side for a slow clock), or null. Steps up
// to `after` are refused: a code is never accepted twice.
function verify(secret, code, { now = Date.now(), window = 1, after = -1 } = {}) {
  const given = Buffer.from(String(code));
  if (!/^\d{6}$/.test(String(code))) return null;
  const current = stepAt(now);
  for (let step = current - window; step <= current + window; step += 1) {
    if (step <= after) continue;
    if (crypto.timingSafeEqual(given, Buffer.from(hotp(secret, step)))) return step;
  }
  return null;
}

const newSecret = () => crypto.randomBytes(20);

// What the app scans: otpauth://totp/<issuer>:<account>?secret=…&issuer=…
function otpauthUrl({ secret, account, issuer = 'YELLOW CRM' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

module.exports = { base32Encode, base32Decode, hotp, codeAt, stepAt, verify, newSecret, otpauthUrl, STEP_SECONDS };
