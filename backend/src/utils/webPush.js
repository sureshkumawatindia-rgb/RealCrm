const crypto = require('crypto');
const httpError = require('./httpError');

// Web push without a library (Phase 10E), with Node's crypto:
// - RFC 8292 (VAPID): the push service learns who sends, from a JWT signed with ES256 (P-256),
//   in Authorization: vapid t=<jwt>, k=<public key>.
// - RFC 8291 + RFC 8188 (aes128gcm): the message is encrypted for the browser's subscription keys
//   (p256dh, auth), so the push service cannot read it.
// sendNotification() → { status } (201 = accepted); 404/410 mean the subscription is gone.
const RECORD_SIZE = 4096;
const TIMEOUT_MS = 10000;

const b64u = (buffer) => Buffer.from(buffer).toString('base64url');
const fromB64u = (text) => Buffer.from(String(text), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// A new VAPID key pair: { publicKey (65-byte uncompressed point), privateKey (32-byte d) } as base64url.
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function privateKeyObject({ publicKey, privateKey }) {
  const point = fromB64u(publicKey);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) },
    format: 'jwk',
  });
}

// The VAPID header for this push service (the audience is its origin), valid 12 hours.
function vapidAuthorization(endpoint, keys, subject) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(signature)}, k=${keys.publicKey}`;
}

// RFC 8291: the payload encrypted for one subscription (one record, aes128gcm). A fresh server
// key pair and salt every time; tests may fix them (fixed: { serverPrivateKey, salt }) to check
// the RFC's own example.
function encrypt(payload, { p256dh, auth }, fixed = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw httpError(400, 'PUSH_KEYS', 'The browser gave push keys of the wrong size.');
  const server = crypto.createECDH('prime256v1');
  if (fixed.serverPrivateKey) server.setPrivateKey(fromB64u(fixed.serverPrivateKey));
  else server.generateKeys();
  const asPublic = server.getPublicKey();
  const sharedSecret = server.computeSecret(uaPublic);
  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const prkKey = hmac(authSecret, sharedSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = fixed.salt ? fromB64u(fixed.salt) : crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02: the last (only) record
  if (plaintext.length + 16 > RECORD_SIZE - 86) throw httpError(400, 'PUSH_TOO_LARGE', 'The notification is too long to send.');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// subscription: { endpoint, keys { p256dh, auth } }; payload: an object (sent as JSON).
async function sendNotification(subscription, payload, { vapidKeys, subject, ttl = 24 * 3600, urgency = 'normal' }) {
  const body = encrypt(JSON.stringify(payload), subscription.keys);
  let response;
  try {
    response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: String(ttl),
        Urgency: urgency,
        Authorization: vapidAuthorization(subscription.endpoint, vapidKeys, subject),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { status: 0 };
  }
  return { status: response.status };
}

module.exports = { generateVapidKeys, vapidAuthorization, encrypt, sendNotification, privateKeyObject };
