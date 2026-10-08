const Session = require('../models/Session');
const TrustedDevice = require('../models/TrustedDevice');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const sessionService = require('./sessionService');
const { shortAgent } = require('./loginService');

// Settings → Your Profile → "Where you're logged in" (2026-10-08), like WhatsApp's linked
// devices: every browser or phone with a live session of this person (one session family each),
// how and when it logged in, when it was last used, and whether it stays logged in. Logging one
// out ends its session at once (middleware/auth.js checks the session) and forgets the browser.

async function currentFamily(req) {
  const session = await Session.findById(req.sessionId).select('familyId');
  return session?.familyId || '';
}

// GET /auth/devices
async function list(req) {
  const [sessions, current] = await Promise.all([
    Session.find({ userId: req.user._id, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }),
    currentFamily(req),
  ]);
  const latest = new Map();
  sessions.forEach((session) => {
    if (!latest.has(session.familyId)) latest.set(session.familyId, session);
  });
  const remembered = await TrustedDevice.find({ userId: req.user._id, familyId: { $in: [...latest.keys()] }, expiresAt: { $gt: new Date() } }).select('familyId expiresAt');
  const rememberedUntil = new Map(remembered.map((device) => [device.familyId, device.expiresAt]));
  const devices = [...latest.values()].map((session) => ({
    id: session.familyId,
    device: shortAgent(session.userAgent),
    method: session.loginMethod || 'google',
    loggedInAt: session.familyStartedAt || session.createdAt,
    lastActiveAt: session.createdAt,
    rememberedUntil: rememberedUntil.get(session.familyId) || null,
    current: session.familyId === current,
  }));
  devices.sort((a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt - a.lastActiveAt);
  return { devices };
}

async function endFamilies(req, familyIds, { reason }) {
  if (!familyIds.length) return;
  await Promise.all(familyIds.map((familyId) => sessionService.revokeFamily(familyId, 'logout')));
  await TrustedDevice.deleteMany({ userId: req.user._id, familyId: { $in: familyIds } });
  await audit(req, { action: 'auth.devices_logged_out', entityType: 'User', entityId: req.user._id, changes: { count: familyIds.length, reason } });
}

// DELETE /auth/devices/:id — one browser or phone (it may be this one).
async function logOut(req, familyId) {
  const owned = await Session.exists({ familyId, userId: req.user._id, revokedAt: null });
  if (!owned) throw httpError(404, 'DEVICE_NOT_FOUND', 'This device is already logged out.');
  await endFamilies(req, [familyId], { reason: 'one' });
  return list(req);
}

// POST /auth/devices/logout-others — everywhere except here.
async function logOutOthers(req) {
  const current = await currentFamily(req);
  const families = await Session.distinct('familyId', { userId: req.user._id, revokedAt: null, familyId: { $ne: current } });
  await endFamilies(req, families, { reason: 'others' });
  return list(req);
}

module.exports = { list, logOut, logOutOthers };
