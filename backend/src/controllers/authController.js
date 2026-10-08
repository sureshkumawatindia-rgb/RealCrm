const authService = require('../services/authService');
const otpService = require('../services/otpService');
const loginService = require('../services/loginService');
const deviceService = require('../services/deviceService');
const { REFRESH_COOKIE, readCookie, setRefreshCookie, clearRefreshCookie } = require('../utils/cookies');

// A finished sign-in: the refresh cookie, and the remembered-browser cookie when asked for.
function finishSignIn(req, res, { refreshToken, data, device }) {
  if (refreshToken) setRefreshCookie(req, res, refreshToken);
  if (device) res.cookie(device.name, device.value, device.options);
  res.json({ success: true, data });
}

// POST /auth/google → signed in, or { step: 'whatsapp-code', challenge, phoneHint } (D58).
async function google(req, res) {
  finishSignIn(req, res, await authService.loginWithGoogle(req, req.body));
}

async function refresh(req, res) {
  try {
    const { refreshToken, data } = await authService.refresh(req, readCookie(req, REFRESH_COOKIE));
    setRefreshCookie(req, res, refreshToken);
    res.json({ success: true, data });
  } catch (error) {
    clearRefreshCookie(req, res);
    throw error;
  }
}

async function logout(req, res) {
  await authService.logout(readCookie(req, REFRESH_COOKIE));
  clearRefreshCookie(req, res);
  await loginService.forgetDevice(req, res);
  res.json({ success: true, data: { loggedOut: true } });
}

async function me(req, res) {
  res.json({ success: true, data: await authService.me(req) });
}

async function switchOrganization(req, res) {
  res.json({ success: true, data: await authService.switchOrganization(req, req.body.organizationId) });
}

// Steps 2 and 3 after Google: the mobile number, then the WhatsApp code.
async function loginCode(req, res) {
  res.json({ success: true, data: await loginService.sendCode(req, req.body) });
}
async function loginVerify(req, res) {
  finishSignIn(req, res, await loginService.verifyCode(req, req.body));
}

// Logging in a computer from the phone (QR).
async function qrStart(req, res) {
  res.json({ success: true, data: await loginService.startQr(req) });
}
async function qrPoll(req, res) {
  const result = await loginService.pollQr(req, { ...req.body, id: req.valid.params.id });
  if (result.status !== 'approved') return res.json({ success: true, data: { status: result.status } });
  return finishSignIn(req, res, { refreshToken: result.refreshToken, device: result.device, data: { status: 'approved', ...result.data } });
}
async function qrPeek(req, res) {
  res.json({ success: true, data: await loginService.peekQr(req, { ...req.body, id: req.valid.params.id }) });
}
async function qrApprove(req, res) {
  res.json({ success: true, data: await loginService.approveQr(req, { ...req.body, id: req.valid.params.id }) });
}

// Where you're logged in (Settings → Your Profile).
async function devices(req, res) {
  res.json({ success: true, data: await deviceService.list(req) });
}
async function deviceLogOut(req, res) {
  res.json({ success: true, data: await deviceService.logOut(req, req.valid.params.id), message: 'Logged out' });
}
async function devicesLogOutOthers(req, res) {
  res.json({ success: true, data: await deviceService.logOutOthers(req), message: 'Logged out everywhere else' });
}

// One's own WhatsApp number (Settings → Your Profile).
async function phoneStatus(req, res) {
  res.json({ success: true, data: otpService.status(req) });
}
async function phoneRequest(req, res) {
  res.json({ success: true, data: await otpService.requestLink(req, req.body) });
}
async function phoneVerify(req, res) {
  res.json({ success: true, data: await otpService.verifyLink(req, req.body), message: 'Number verified' });
}
async function phoneUnlink(req, res) {
  res.json({ success: true, data: await otpService.unlink(req), message: 'Number removed' });
}

module.exports = {
  google, refresh, logout, me, switchOrganization, loginCode, loginVerify, qrStart, qrPoll, qrPeek, qrApprove,
  devices, deviceLogOut, devicesLogOutOthers, phoneStatus, phoneRequest, phoneVerify, phoneUnlink,
};
