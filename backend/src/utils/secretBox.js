const crypto = require('crypto');
const env = require('../config/env');

// AES-256-GCM. New values use DATA_ENCRYPTION_KEY and are prefixed "v2.".
// Values without the prefix were written with GMAIL_TOKEN_ENCRYPTION_KEY and stay readable.
const V2_PREFIX = 'v2.';

function keyFrom(secret, name) {
  if (!secret) {
    const error = new Error(`${name} is not configured`);
    error.statusCode = 500;
    error.code = 'ENCRYPTION_KEY_MISSING';
    throw error;
  }
  return crypto.createHash('sha256').update(secret).digest();
}

const legacyKey = () => keyFrom(env.gmailTokenEncryptionKey, 'GMAIL_TOKEN_ENCRYPTION_KEY');
const dataKey = () => keyFrom(env.dataEncryptionKey, 'DATA_ENCRYPTION_KEY');

function seal(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function open(value, key) {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function encrypt(value) {
  if (env.dataEncryptionKey) return V2_PREFIX + seal(value, dataKey());
  return seal(value, legacyKey());
}

function decrypt(value) {
  if (value.startsWith(V2_PREFIX)) return open(value.slice(V2_PREFIX.length), dataKey());
  return open(value, legacyKey());
}

module.exports = { encrypt, decrypt };
