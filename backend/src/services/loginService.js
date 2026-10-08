const QRCode = require('qrcode');
const mongoose = require('mongoose');
const User = require('../models/User');
const TrustedDevice = require('../models/TrustedDevice');
const QrLogin = require('../models/QrLogin');
const OrganizationMember = require('../models/OrganizationMember');
const env = require('../config/env');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { signLoginChallenge, verifyLoginChallenge, randomToken, hashToken } = require('../utils/tokens');
const otpService = require('./otpService');
const authService = require('./authService');

// Logging in (D58, changed by D60): Google; then, for people with 2-step verification on (or
// everyone with LOGIN_WHATSAPP_CODE=required), their mobile number and a 6-digit code on WhatsApp
// (or SMS, the backup) on a new browser. "Stay logged in on this browser" remembers the browser for
// 30 days (Google alone there). Or: log in on another computer by scanning the code it shows
// (login.html?with=phone) with a phone where the person is signed in. When the CRM cannot send codes
// (OTP_PROVIDER off), Google alone logs in.
const DEVICE_COOKIE = 'crm_device';
const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const QR_TTL_MS = 2 * 60 * 1000;
const AUTH_COOKIE_PATH = '/api/v1/auth';

// The WhatsApp code after Google (2-step verification): for everyone (required), for those who
// switched it on with a verified number (optional, the default since D60), or for nobody (off).
const secondStepOn = (user) => otpService.available() && (env.login.whatsappCode === 'required'
  || (env.login.whatsappCode === 'optional' && Boolean(user?.twoStepEnabledAt && user.phoneE164 && user.phoneVerifiedAt)));
const masked = (phoneE164) => (phoneE164 ? `${phoneE164.slice(0, 3)} ••••• ${phoneE164.slice(-4)}` : '');
const shortAgent = (ua) => {
  const text = String(ua || '');
  const browser = /Edg\//.test(text) ? 'Edge' : /OPR\//.test(text) ? 'Opera' : /Firefox\//.test(text) ? 'Firefox' : /Chrome\//.test(text) ? 'Chrome' : /Safari\//.test(text) ? 'Safari' : 'A browser';
  const system = /Windows/.test(text) ? 'Windows' : /Mac OS X/.test(text) ? 'Mac' : /Android/.test(text) ? 'Android' : /iPhone|iPad/.test(text) ? 'iPhone' : /Linux/.test(text) ? 'Linux' : '';
  return system ? `${browser} on ${system}` : browser;
};

// --- the remembered browser ----------------------------------------------------------------------
function readDeviceCookie(req) {
  const header = req.get('cookie') || '';
  const part = header.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${DEVICE_COOKIE}=`));
  return part ? decodeURIComponent(part.slice(DEVICE_COOKIE.length + 1)) : '';
}

async function trustedFor(req, user) {
  const token = readDeviceCookie(req);
  if (!token) return false;
  const device = await TrustedDevice.findOneAndUpdate(
    { tokenHash: hashToken(token), userId: user._id, expiresAt: { $gt: new Date() } },
    { $set: { lastUsedAt: new Date() } },
  );
  return Boolean(device);
}

// Signing out forgets the browser too (a shared computer must ask for the code again).
async function forgetDevice(req, res) {
  const token = readDeviceCookie(req);
  if (token) await TrustedDevice.deleteOne({ tokenHash: hashToken(token) });
  res.clearCookie(DEVICE_COOKIE, { httpOnly: true, sameSite: 'strict', secure: env.isProduction || req.secure, path: AUTH_COOKIE_PATH });
}

// → a cookie for the controller to set: { name, value, options }. familyId ties the browser to
// its entry under "Where you're logged in", so logging it out there forgets it too.
async function rememberDevice(req, userId, familyId) {
  const token = randomToken();
  await TrustedDevice.create({ userId, familyId, tokenHash: hashToken(token), userAgent: String(req.get('user-agent') || '').slice(0, 300), expiresAt: new Date(Date.now() + DEVICE_TTL_MS) });
  return {
    name: DEVICE_COOKIE,
    value: token,
    options: { httpOnly: true, sameSite: 'strict', secure: env.isProduction || req.secure, path: AUTH_COOKIE_PATH, maxAge: DEVICE_TTL_MS },
  };
}

// A remembered browser logged in with Google alone: its new session is the one to log out there.
async function linkRememberedBrowser(req, user, familyId) {
  const token = readDeviceCookie(req);
  if (token) await TrustedDevice.updateOne({ tokenHash: hashToken(token), userId: user._id }, { $set: { familyId } });
}

// --- after Google -------------------------------------------------------------------------------------
// Called by authService.loginWithGoogle. → null (sign in now) or what the login page needs for
// steps 2 and 3.
async function secondStepFor(req, user, { invitedOrganizationId, inviteError }) {
  if (!secondStepOn(user) || await trustedFor(req, user)) return null;
  const verified = user.phoneE164 && user.phoneVerifiedAt ? user.phoneE164 : '';
  return {
    step: 'whatsapp-code',
    challenge: signLoginChallenge({ userId: user._id, invitedOrganizationId, inviteError }),
    phone: verified, // filled in for them (they have just proved the Google account)
    phoneHint: masked(verified),
    smsBackup: otpService.smsAvailable(),
    user: { email: user.email, name: user.name, picture: user.picture },
  };
}

async function userOfChallenge(challenge) {
  let claims;
  try {
    claims = verifyLoginChallenge(challenge);
  } catch {
    throw httpError(400, 'LOGIN_EXPIRED', 'This sign-in took too long. Sign in with Google again.');
  }
  const user = await User.findById(claims.sub);
  if (!user || user.disabledAt) throw httpError(400, 'LOGIN_EXPIRED', 'Sign in with Google again.');
  return { user, claims };
}

// POST /auth/login/code { challenge, phone, channel } — step 2: the code goes to the person's
// number on WhatsApp, or by SMS when they ask for the backup.
async function sendCode(req, { challenge, phone, channel = 'whatsapp' }) {
  if (!otpService.available()) throw httpError(409, 'OTP_OFF', 'Codes on WhatsApp are not switched on for this CRM yet.');
  if (channel === 'sms' && !otpService.smsAvailable()) throw httpError(409, 'SMS_OFF', 'Codes by SMS are not switched on for this CRM.');
  const { user } = await userOfChallenge(challenge);
  const phoneE164 = otpService.phoneOf(phone);
  if (user.phoneE164 && user.phoneVerifiedAt && user.phoneE164 !== phoneE164) {
    throw httpError(400, 'PHONE_MISMATCH', `Enter the mobile number of this account (${masked(user.phoneE164)}).`, [{ field: 'phone', message: 'Not the number of this account.' }]);
  }
  if (await User.exists({ phoneE164, _id: { $ne: user._id } })) {
    throw httpError(409, 'PHONE_IN_USE', 'This number belongs to another account.', [{ field: 'phone', message: 'This number belongs to another account.' }]);
  }
  await otpService.issue(req, { phoneE164, purpose: 'login', userId: user._id, send: true, channel });
  return {
    sent: true, channel,
    message: channel === 'sms' ? 'A 6-digit code is on its way by SMS.' : 'A 6-digit code is on its way on WhatsApp.',
    expiresInSeconds: otpService.CODE_TTL_MS / 1000,
  };
}

// POST /auth/login/verify { challenge, phone, code, stayLoggedIn } — step 3: signed in.
async function verifyCode(req, { challenge, phone, code, stayLoggedIn }) {
  if (!otpService.available()) throw httpError(409, 'OTP_OFF', 'Codes on WhatsApp are not switched on for this CRM yet.');
  const { user, claims } = await userOfChallenge(challenge);
  const phoneE164 = otpService.phoneOf(phone);
  const used = await otpService.check({ phoneE164, purpose: 'login', userId: user._id, code });
  if (!user.phoneVerifiedAt || user.phoneE164 !== phoneE164) {
    try {
      await User.updateOne({ _id: user._id }, { $set: { phoneE164, phoneVerifiedAt: new Date() } });
    } catch (error) {
      if (error.code === 11000) throw httpError(409, 'PHONE_IN_USE', 'This number belongs to another account.');
      throw error;
    }
  }
  const session = await authService.startSession(req, await User.findById(user._id), {
    invitedOrganizationId: claims.inv, inviteError: claims.err || null, method: `google+${used.channel || 'whatsapp'}`,
  });
  return { ...session, device: stayLoggedIn ? await rememberDevice(req, user._id, session.familyId) : null };
}

// --- QR: log in a computer from the phone -------------------------------------------------------------
const linkUrlOf = (id, secret) => `${env.publicUrl}/crm/frontend/link-device.html#${id}.${secret}`;

// POST /auth/qr — the computer asks for a code to show.
async function startQr(req) {
  const secret = randomToken();
  const qr = await QrLogin.create({
    secretHash: hashToken(secret), expiresAt: new Date(Date.now() + QR_TTL_MS),
    computerUserAgent: String(req.get('user-agent') || '').slice(0, 300), computerIp: String(req.ip || '').slice(0, 64),
  });
  const link = linkUrlOf(qr._id, secret);
  return { id: qr._id, secret, image: await QRCode.toDataURL(link, { margin: 1, width: 264, errorCorrectionLevel: 'Q' }), expiresAt: qr.expiresAt };
}

async function findQr(id, secret) {
  const qr = mongoose.isValidObjectId(id) ? await QrLogin.findById(id) : null;
  if (!qr || qr.secretHash !== hashToken(secret)) throw httpError(404, 'QR_NOT_FOUND', 'This code is not valid. Show a new one on the computer.');
  return qr;
}

// POST /auth/qr/:id/peek { secret } — the phone (signed in) sees which computer asks.
async function peekQr(req, { id, secret }) {
  const qr = await findQr(id, secret);
  if (qr.status !== 'pending' || qr.expiresAt <= new Date()) throw httpError(410, 'QR_EXPIRED', 'This code has expired. Show a new one on the computer.');
  return { computer: shortAgent(qr.computerUserAgent), askedAt: qr.createdAt, expiresAt: qr.expiresAt };
}

// POST /auth/qr/:id/approve { secret, allow } — the phone allows (or declines) it.
async function approveQr(req, { id, secret, allow = true }) {
  const qr = await findQr(id, secret);
  const decided = await QrLogin.findOneAndUpdate(
    { _id: qr._id, status: 'pending', expiresAt: { $gt: new Date() } },
    { $set: allow ? { status: 'approved', approvedByUserId: req.user._id, organizationId: req.tenant.organizationId, approvedAt: new Date() } : { status: 'declined' } },
    { returnDocument: 'after' },
  );
  if (!decided) throw httpError(410, 'QR_EXPIRED', 'This code has expired. Show a new one on the computer.');
  if (allow) await audit(req, { action: 'auth.computer_linked', entityType: 'User', entityId: req.user._id, changes: { computer: shortAgent(qr.computerUserAgent) } });
  return { allowed: Boolean(allow), computer: shortAgent(qr.computerUserAgent) };
}

// POST /auth/qr/:id/poll { secret, stayLoggedIn } — the computer asks until it is allowed.
// → { status: pending | declined | expired } or, once, the session.
async function pollQr(req, { id, secret, stayLoggedIn }) {
  const qr = await findQr(id, secret);
  if (qr.status === 'declined') return { status: 'declined' };
  if (qr.status === 'pending') return { status: qr.expiresAt <= new Date() ? 'expired' : 'pending' };
  const used = await QrLogin.findOneAndUpdate({ _id: qr._id, status: 'approved' }, { $set: { status: 'used' } });
  if (!used) return { status: 'expired' };
  const user = await User.findById(qr.approvedByUserId);
  const member = user && await OrganizationMember.exists({ organizationId: qr.organizationId, userId: user._id, status: 'active' });
  if (!user || user.disabledAt || !member) return { status: 'expired' };
  const session = await authService.startSession(req, user, { invitedOrganizationId: qr.organizationId, method: 'qr' });
  return { status: 'approved', ...session, device: stayLoggedIn ? await rememberDevice(req, user._id, session.familyId) : null };
}

module.exports = {
  secondStepFor, sendCode, verifyCode, startQr, peekQr, approveQr, pollQr, readDeviceCookie, trustedFor, forgetDevice, linkRememberedBrowser,
  secondStepOn, masked, shortAgent, DEVICE_COOKIE,
};
