const crypto = require('crypto');
const User = require('../models/User');
const OtpChallenge = require('../models/OtpChallenge');
const env = require('../config/env');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { normalizePhone } = require('../utils/phone');
const whatsappOtp = require('../integrations/whatsapp/otp');

// 6-digit codes on WhatsApp from the platform's number (Phase 10E; since 2026-10-08 the second,
// required step of every sign-in after Google — services/loginService.js — and how a member
// changes their number in Settings → Your Profile). Codes: HMAC-stored, 5 minutes, 5 tries, one
// use; at most 3 codes per number in 15 minutes.
// OTP_PROVIDER: whatsapp (the platform's number and template), mock (development: the code is
// returned as devCode, never in production), off.
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_WINDOW = 3;

const provider = () => env.otp.provider;
const available = () => provider() === 'mock' || (provider() === 'whatsapp' && Boolean(env.otp.phoneNumberId && env.otp.accessToken && env.otp.template));
const hashOf = (phoneE164, code) => crypto.createHmac('sha256', env.jwtSecret).update(`otp:${phoneE164}:${code}`).digest('hex');
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

function phoneOf(raw) {
  const phoneE164 = normalizePhone(raw);
  if (!phoneE164) throw httpError(400, 'VALIDATION_ERROR', 'Enter a valid mobile number.', [{ field: 'phone', message: 'Enter a valid mobile number.' }]);
  return phoneE164;
}

async function assertNotFlooded(phoneE164) {
  const recent = await OtpChallenge.countDocuments({ phoneE164, createdAt: { $gte: new Date(Date.now() - WINDOW_MS) } });
  if (recent >= MAX_PER_WINDOW) throw httpError(429, 'OTP_TOO_MANY', 'Too many codes for this number. Wait 15 minutes and try again.');
}

// Makes a code and (when send) sends it. → the code in development (mock), else undefined.
async function issue(req, { phoneE164, purpose, userId = null, send }) {
  await assertNotFlooded(phoneE164);
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await OtpChallenge.create({
    phoneE164, purpose, userId, codeHash: hashOf(phoneE164, send ? code : crypto.randomBytes(8).toString('hex')),
    sent: send, expiresAt: new Date(Date.now() + CODE_TTL_MS), ip: String(req.ip || '').slice(0, 64),
  });
  if (!send) return undefined;
  if (provider() === 'mock') return code;
  await whatsappOtp.sendCode({ phoneNumberId: env.otp.phoneNumberId, accessToken: env.otp.accessToken, template: env.otp.template, language: env.otp.language }, phoneE164, code);
  return undefined;
}

// The latest code for this number and purpose, checked; the code is used up when it is right.
async function check({ phoneE164, purpose, userId = null, code }) {
  const filter = { phoneE164, purpose, consumedAt: null, expiresAt: { $gt: new Date() }, ...(userId && { userId }) };
  const challenge = await OtpChallenge.findOne(filter).sort({ createdAt: -1 });
  if (!challenge) throw httpError(401, 'OTP_INVALID', 'The code is wrong or has expired. Ask for a new one.');
  if (challenge.attempts >= MAX_ATTEMPTS) throw httpError(401, 'OTP_LOCKED', 'Too many wrong codes. Ask for a new one.');
  if (!challenge.sent || !sameHash(challenge.codeHash, hashOf(phoneE164, String(code).trim()))) {
    await OtpChallenge.updateOne({ _id: challenge._id }, { $inc: { attempts: 1 } });
    throw httpError(401, 'OTP_INVALID', 'The code is wrong or has expired. Ask for a new one.');
  }
  const used = await OtpChallenge.findOneAndUpdate({ _id: challenge._id, consumedAt: null }, { $set: { consumedAt: new Date() } });
  if (!used) throw httpError(401, 'OTP_INVALID', 'The code is wrong or has expired. Ask for a new one.');
  return challenge;
}

function assertAvailable() {
  if (!available()) throw httpError(409, 'OTP_OFF', 'Codes on WhatsApp are not switched on for this CRM yet.');
}

// --- the member's own number (signed in) ---------------------------------------------------------------
function status(req) {
  return {
    phone: req.user.phoneE164 || '',
    verifiedAt: req.user.phoneVerifiedAt || null,
    available: available(),
  };
}

// POST /auth/phone/request { phone }
async function requestLink(req, { phone }) {
  assertAvailable();
  const phoneE164 = phoneOf(phone);
  const taken = await User.exists({ phoneE164, _id: { $ne: req.user._id } });
  if (taken) throw httpError(409, 'PHONE_IN_USE', 'This number is already linked to another account.');
  const devCode = await issue(req, { phoneE164, purpose: 'link', userId: req.user._id, send: true });
  return { sent: true, message: 'A 6-digit code is on its way on WhatsApp.', expiresInSeconds: CODE_TTL_MS / 1000, ...(devCode && { devCode }) };
}

// POST /auth/phone/verify { phone, code }
async function verifyLink(req, { phone, code }) {
  assertAvailable();
  const phoneE164 = phoneOf(phone);
  await check({ phoneE164, purpose: 'link', userId: req.user._id, code });
  try {
    await User.updateOne({ _id: req.user._id }, { $set: { phoneE164, phoneVerifiedAt: new Date() } });
  } catch (error) {
    if (error.code === 11000) throw httpError(409, 'PHONE_IN_USE', 'This number is already linked to another account.');
    throw error;
  }
  await audit(req, { action: 'auth.phone_linked', entityType: 'User', entityId: req.user._id });
  return { phone: phoneE164, verifiedAt: new Date(), available: available() };
}

// DELETE /auth/phone
async function unlink(req) {
  await User.updateOne({ _id: req.user._id }, { $unset: { phoneE164: 1, phoneVerifiedAt: 1 } });
  await audit(req, { action: 'auth.phone_unlinked', entityType: 'User', entityId: req.user._id });
  return { phone: '', verifiedAt: null, available: available() };
}

module.exports = { available, issue, check, phoneOf, status, requestLink, verifyLink, unlink, CODE_TTL_MS, MAX_ATTEMPTS };
