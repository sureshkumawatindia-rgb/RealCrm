const crypto = require('crypto');
const User = require('../models/User');
const OtpChallenge = require('../models/OtpChallenge');
const env = require('../config/env');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { normalizePhone } = require('../utils/phone');
const whatsappOtp = require('../integrations/whatsapp/otp');
const msg91 = require('../integrations/sms/msg91');

// 6-digit codes on WhatsApp from the platform's number (Phase 10E): 2-step verification after
// Google (D58, optional since D60 — services/loginService.js) and how a member verifies or
// changes their number in Settings → Your Profile. Codes: HMAC-stored, 5 minutes, 5 tries, one
// use; at most 3 codes per number in 15 minutes.
// OTP_PROVIDER: whatsapp (the platform's number and template), mock (development: nothing is
// sent and the code is never shown on screen — it is in the server log, and codeFor() hands it
// to the tests; never in production), off. SMS_PROVIDER (msg91 / mock / off) is the backup
// channel of the login: the same codes and limits, sent by SMS.
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_WINDOW = 3;

const provider = () => env.otp.provider;
const available = () => provider() === 'mock' || (provider() === 'whatsapp' && Boolean(env.otp.phoneNumberId && env.otp.accessToken && env.otp.template));
const smsAvailable = () => env.sms.provider === 'mock' || (env.sms.provider === 'msg91' && Boolean(env.sms.msg91AuthKey && env.sms.msg91TemplateId));
const hashOf = (phoneE164, code) => crypto.createHmac('sha256', env.jwtSecret).update(`otp:${phoneE164}:${code}`).digest('hex');
// Development (mock) codes: the last one per number, for the server log and the tests.
const mockCodes = new Map();
function deliverMock(phoneE164, code, channel) {
  mockCodes.set(phoneE164, code);
  logger.info(`Development ${channel} code for ${phoneE164}: ${code} (nothing is sent)`);
}
const codeFor = (phoneE164) => (env.isProduction ? undefined : mockCodes.get(phoneE164));
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

// Makes a code and (when send) sends it on WhatsApp or, for channel 'sms', by SMS.
async function issue(req, { phoneE164, purpose, userId = null, send, channel = 'whatsapp' }) {
  await assertNotFlooded(phoneE164);
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await OtpChallenge.create({
    phoneE164, purpose, userId, channel, codeHash: hashOf(phoneE164, send ? code : crypto.randomBytes(8).toString('hex')),
    sent: send, expiresAt: new Date(Date.now() + CODE_TTL_MS), ip: String(req.ip || '').slice(0, 64),
  });
  if (!send) return;
  if (channel === 'sms') {
    if (env.sms.provider === 'mock') return deliverMock(phoneE164, code, 'SMS');
    await msg91.sendCode({ authKey: env.sms.msg91AuthKey, templateId: env.sms.msg91TemplateId }, phoneE164, code, { expiryMinutes: CODE_TTL_MS / 60000 });
    return;
  }
  if (provider() === 'mock') return deliverMock(phoneE164, code, 'WhatsApp');
  await whatsappOtp.sendCode({ phoneNumberId: env.otp.phoneNumberId, accessToken: env.otp.accessToken, template: env.otp.template, language: env.otp.language }, phoneE164, code);
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
function status(req, user = req.user) {
  return {
    phone: user.phoneE164 || '',
    verifiedAt: user.phoneVerifiedAt || null,
    available: available(),
    // 2-step verification (D60): optional = each person chooses; required / off = for everyone.
    twoStep: env.login.whatsappCode === 'required' || (env.login.whatsappCode === 'optional' && Boolean(user.twoStepEnabledAt)),
    twoStepMode: env.login.whatsappCode,
  };
}

// PUT /auth/two-step { enabled } — needs a verified number and codes that can be sent.
async function setTwoStep(req, { enabled }) {
  if (env.login.whatsappCode !== 'optional') throw httpError(409, 'TWO_STEP_FIXED', env.login.whatsappCode === 'required' ? 'This CRM always asks for the WhatsApp code.' : '2-step verification is switched off for this CRM.');
  if (enabled) {
    assertAvailable();
    if (!req.user.phoneE164 || !req.user.phoneVerifiedAt) throw httpError(400, 'PHONE_REQUIRED', 'Verify your mobile number first.');
  }
  const user = await User.findOneAndUpdate({ _id: req.user._id }, enabled ? { $set: { twoStepEnabledAt: new Date() } } : { $unset: { twoStepEnabledAt: 1 } }, { returnDocument: 'after' });
  await audit(req, { action: enabled ? 'auth.two_step_on' : 'auth.two_step_off', entityType: 'User', entityId: req.user._id });
  return status(req, user);
}

// POST /auth/phone/request { phone }
async function requestLink(req, { phone }) {
  assertAvailable();
  const phoneE164 = phoneOf(phone);
  const taken = await User.exists({ phoneE164, _id: { $ne: req.user._id } });
  if (taken) throw httpError(409, 'PHONE_IN_USE', 'This number is already linked to another account.');
  await issue(req, { phoneE164, purpose: 'link', userId: req.user._id, send: true });
  return { sent: true, message: 'A 6-digit code is on its way on WhatsApp.', expiresInSeconds: CODE_TTL_MS / 1000 };
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
  return status(req, await User.findById(req.user._id));
}

// DELETE /auth/phone
async function unlink(req) {
  // Without a number there is no 2-step verification either.
  const user = await User.findOneAndUpdate({ _id: req.user._id }, { $unset: { phoneE164: 1, phoneVerifiedAt: 1, twoStepEnabledAt: 1 } }, { returnDocument: 'after' });
  await audit(req, { action: 'auth.phone_unlinked', entityType: 'User', entityId: req.user._id });
  return status(req, user);
}

module.exports = { available, smsAvailable, issue, check, phoneOf, status, setTwoStep, requestLink, verifyLink, unlink, codeFor, CODE_TTL_MS, MAX_ATTEMPTS };
