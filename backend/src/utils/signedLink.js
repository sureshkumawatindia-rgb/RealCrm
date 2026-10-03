const crypto = require('crypto');
const env = require('../config/env');

// Public links that cannot be guessed or changed: "<id>.<signature>", where the signature is
// an HMAC of the id with a key derived from JWT_SECRET for one purpose (e.g. "quotation").
// Nothing is stored; changing JWT_SECRET makes every earlier link stop working.
const keyFor = (purpose) => crypto.createHmac('sha256', env.jwtSecret).update(`signed-link:${purpose}`).digest();
const signatureOf = (purpose, id) => crypto.createHmac('sha256', keyFor(purpose)).update(String(id)).digest('base64url');

function sign(purpose, id) {
  return `${id}.${signatureOf(purpose, id)}`;
}

// → the id, or null for a link that was not made by this server for this purpose.
function verify(purpose, token) {
  const [id, signature, extra] = String(token || '').split('.');
  if (extra !== undefined || !/^[a-f0-9]{24}$/.test(id || '') || !signature) return null;
  const expected = Buffer.from(signatureOf(purpose, id));
  const given = Buffer.from(signature);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? id : null;
}

module.exports = { sign, verify };
