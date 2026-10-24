const crypto = require('crypto');
const QRCode = require('qrcode');
const User = require('../models/User');
const TrustedDevice = require('../models/TrustedDevice');
const OrganizationMember = require('../models/OrganizationMember');
const env = require('../config/env');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { encrypt, decrypt } = require('../utils/secretBox');
const { hashToken } = require('../utils/tokens');
const { isManager } = require('../constants/permissions');
const totp = require('../utils/totp');

// 2-step login with an authenticator app (F7, docs/FOUNDATION_30_DAY_PLAN.md):
// - set up from the 2-step login page: a QR code for Google Authenticator or a similar app, then a
//   6-digit code to confirm, then 10 backup codes (each works once);
// - after Google on a browser that is not remembered, the app's code (or a backup code) comes next;
// - owners and admins must have it: TOTP_GRACE_DAYS after they are first asked, the CRM sends them
//   to the set-up page until they do; they cannot switch it off (another owner or admin, or
//   support, resets it when a phone is lost);
// - 5 wrong codes lock it for 15 minutes; a code is never accepted twice.

const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_MS = 15 * 60 * 1000;
const MAX_WRONG = 5;
const LOCK_MS = 15 * 60 * 1000;
const BACKUP_CODES = 10;

const enabled = (user) => Boolean(user?.totp?.enabledAt && user.totp.secretEnc);
const requiredFor = (member) => env.login.totpRequiredForManagers && isManager(member);
const backupLeft = (user) => (user?.totp?.backupCodes || []).filter((c) => !c.usedAt).length;
// "abcd-efgh": letters and digits that cannot be mistaken for one another.
const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const newBackupCode = () => Array.from(crypto.randomBytes(8), (byte) => BACKUP_ALPHABET[byte % BACKUP_ALPHABET.length]).join('').replace(/^(.{4})/, '$1-');
const normalizeBackup = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function newBackupCodes() {
  const codes = Array.from({ length: BACKUP_CODES }, newBackupCode);
  return { codes, stored: codes.map((code) => ({ hash: hashToken(`totp-backup:${normalizeBackup(code)}`) })) };
}

// What the person and the pages need to know (GET /auth/totp, and the user summary).
function summaryOf(user, member) {
  return {
    enabled: enabled(user),
    enabledAt: user?.totp?.enabledAt || null,
    backupCodesLeft: enabled(user) ? backupLeft(user) : 0,
    required: Boolean(member && requiredFor(member)),
    requiredBy: (member && requiredFor(member) && !enabled(user) && user?.totp?.requiredBy) || null,
  };
}

const status = (req) => summaryOf(req.user, req.member);

// Step 1: a new secret (kept aside until confirmed) and the QR code to scan.
async function setup(req) {
  if (enabled(req.user)) throw httpError(409, 'TOTP_ALREADY_ON', '2-step login is already on.');
  const secret = totp.newSecret();
  await User.updateOne({ _id: req.user._id }, { $set: { 'totp.pendingSecretEnc': encrypt(totp.base32Encode(secret)), 'totp.pendingAt': new Date() } });
  const url = totp.otpauthUrl({ secret, account: req.user.email });
  return {
    qr: await QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' }),
    secret: totp.base32Encode(secret).replace(/(.{4})/g, '$1 ').trim(),
    url,
  };
}

// Step 2: the first code from the app turns it on; the backup codes are shown this once.
async function enable(req, { code }) {
  const user = await User.findById(req.user._id);
  if (enabled(user)) throw httpError(409, 'TOTP_ALREADY_ON', '2-step login is already on.');
  if (!user.totp?.pendingSecretEnc || !user.totp.pendingAt || Date.now() - user.totp.pendingAt.getTime() > PENDING_MS) {
    throw httpError(400, 'TOTP_SETUP_EXPIRED', 'Scan a new QR code: this one has expired.');
  }
  const secret = totp.base32Decode(decrypt(user.totp.pendingSecretEnc));
  const step = totp.verify(secret, String(code || '').replace(/\s/g, ''));
  if (step === null) throw httpError(400, 'TOTP_WRONG_CODE', 'That code is not right. Enter the 6 digits the app shows now.', [{ field: 'code', message: 'Wrong code.' }]);
  const { codes, stored } = newBackupCodes();
  await User.updateOne({ _id: user._id }, {
    $set: { 'totp.secretEnc': user.totp.pendingSecretEnc, 'totp.enabledAt': new Date(), 'totp.lastStep': step, 'totp.backupCodes': stored, 'totp.failedCount': 0 },
    $unset: { 'totp.pendingSecretEnc': 1, 'totp.pendingAt': 1, 'totp.lockedUntil': 1, 'totp.requiredBy': 1 },
  });
  await audit(req, { action: 'auth.totp_on', entityType: 'User', entityId: user._id });
  return { enabled: true, backupCodes: codes };
}

// A code at sign-in or to change the setting: the app's 6 digits, or a backup code (once).
// → 'app' | 'backup'; wrong codes count towards the lock.
async function checkCode(user, code) {
  const fresh = await User.findById(user._id);
  if (!enabled(fresh)) throw httpError(400, 'TOTP_OFF', '2-step login is not on for this account.');
  if (fresh.totp.lockedUntil && fresh.totp.lockedUntil > new Date()) {
    throw httpError(429, 'TOTP_LOCKED', 'Too many wrong codes. Wait 15 minutes, or use a backup code later.');
  }
  const given = String(code || '').trim();
  if (/^\d{6}$/.test(given)) {
    const step = totp.verify(totp.base32Decode(decrypt(fresh.totp.secretEnc)), given, { after: fresh.totp.lastStep ?? -1 });
    // The step moves forward only once, even when two requests bring the same code together.
    if (step !== null) {
      const taken = await User.updateOne(
        { _id: fresh._id, $or: [{ 'totp.lastStep': { $lt: step } }, { 'totp.lastStep': { $exists: false } }] },
        { $set: { 'totp.lastStep': step, 'totp.failedCount': 0 }, $unset: { 'totp.lockedUntil': 1 } },
      );
      if (taken.modifiedCount) return 'app';
    }
  } else if (normalizeBackup(given).length === 8) {
    const hash = hashToken(`totp-backup:${normalizeBackup(given)}`);
    const used = await User.updateOne(
      { _id: fresh._id, 'totp.backupCodes': { $elemMatch: { hash, usedAt: { $exists: false } } } },
      { $set: { 'totp.backupCodes.$.usedAt': new Date(), 'totp.failedCount': 0 }, $unset: { 'totp.lockedUntil': 1 } },
    );
    if (used.modifiedCount) return 'backup';
  }
  const wrong = (fresh.totp.failedCount || 0) + 1;
  await User.updateOne({ _id: fresh._id }, wrong >= MAX_WRONG
    ? { $set: { 'totp.failedCount': 0, 'totp.lockedUntil': new Date(Date.now() + LOCK_MS) } }
    : { $set: { 'totp.failedCount': wrong } });
  throw httpError(401, 'TOTP_WRONG_CODE', 'That code is not right. Enter the 6 digits the app shows now, or a backup code.', [{ field: 'code', message: 'Wrong code.' }]);
}

async function newCodes(req, { code }) {
  await checkCode(req.user, code);
  const { codes, stored } = newBackupCodes();
  await User.updateOne({ _id: req.user._id }, { $set: { 'totp.backupCodes': stored } });
  await audit(req, { action: 'auth.totp_backup_codes', entityType: 'User', entityId: req.user._id });
  return { backupCodes: codes };
}

async function disable(req, { code }) {
  if (requiredFor(req.member)) throw httpError(403, 'TOTP_REQUIRED', 'Owners and admins keep 2-step login on. You can make new backup codes instead.');
  await checkCode(req.user, code);
  await User.updateOne({ _id: req.user._id }, { $unset: { totp: 1 } });
  await audit(req, { action: 'auth.totp_off', entityType: 'User', entityId: req.user._id });
  return { enabled: false };
}

// Turned off for someone who lost their phone: by another owner or admin of their only company,
// or by support (scripts/totp-reset.js). Their remembered browsers are forgotten too, and an owner
// or admin gets a fresh grace period to set it up again.
async function resetFor(userId) {
  const graceUntil = new Date(Date.now() + env.login.totpGraceDays * DAY_MS);
  await User.updateOne({ _id: userId }, { $unset: { totp: 1 } });
  await User.updateOne({ _id: userId }, { $set: { 'totp.requiredBy': graceUntil } });
  await TrustedDevice.deleteMany({ userId });
}

// For authenticate: an owner or admin past the grace period without the app is kept to the
// sign-in pages (/auth/…), where the set-up is. The first time they are seen, the clock starts.
async function enforce(req) {
  if (!requiredFor(req.member) || enabled(req.user)) return;
  const requiredBy = req.user.totp?.requiredBy;
  if (!requiredBy) {
    const by = new Date(Date.now() + env.login.totpGraceDays * DAY_MS);
    await User.updateOne({ _id: req.user._id, 'totp.requiredBy': { $exists: false } }, { $set: { 'totp.requiredBy': by } });
    if (env.login.totpGraceDays > 0) return;
  } else if (requiredBy > new Date()) {
    return;
  }
  if (req.originalUrl.startsWith('/api/v1/auth/')) return;
  throw httpError(403, 'TOTP_SETUP_REQUIRED', 'Your company needs owners and admins to use 2-step login. Turn it on to continue.');
}

// Whether a member may reset this person's app: same company, not themselves, an admin never an
// owner's, and the person in no other company (each company only decides for itself).
async function assertMayReset(req, member) {
  if (String(member.userId?._id || member.userId) === String(req.user._id)) throw httpError(400, 'TOTP_RESET_SELF', 'You cannot reset your own 2-step login. Ask another owner or admin.');
  if (member.role === 'owner' && req.member.role !== 'owner') throw httpError(403, 'FORBIDDEN', 'Only an owner can reset an owner\'s 2-step login.');
  const elsewhere = await OrganizationMember.exists({ userId: member.userId?._id || member.userId, status: 'active', organizationId: { $ne: req.tenant.organizationId } });
  if (elsewhere) throw httpError(409, 'TOTP_RESET_OTHER_COMPANIES', 'This person also belongs to other companies, so only support can reset their 2-step login.');
}

module.exports = { status, setup, enable, disable, newCodes, checkCode, resetFor, enforce, assertMayReset, summaryOf, enabled, MAX_WRONG };
