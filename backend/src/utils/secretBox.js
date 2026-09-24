const crypto = require('crypto');
const env = require('../config/env');

function encryptionKey() {
  if (!env.gmailTokenEncryptionKey) {
    const error = new Error('GMAIL_TOKEN_ENCRYPTION_KEY is not configured');
    error.statusCode = 500;
    error.code = 'GMAIL_ENCRYPTION_KEY_MISSING';
    throw error;
  }
  return crypto.createHash('sha256').update(env.gmailTokenEncryptionKey).digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decrypt(value) {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };