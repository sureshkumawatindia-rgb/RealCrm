const authService = require('../services/authService');
const otpService = require('../services/otpService');
const { REFRESH_COOKIE, readCookie, setRefreshCookie, clearRefreshCookie } = require('../utils/cookies');

async function google(req, res) {
  const { refreshToken, data } = await authService.loginWithGoogle(req, req.body);
  setRefreshCookie(req, res, refreshToken);
  res.json({ success: true, data });
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
  res.json({ success: true, data: { loggedOut: true } });
}

async function me(req, res) {
  res.json({ success: true, data: await authService.me(req) });
}

async function switchOrganization(req, res) {
  res.json({ success: true, data: await authService.switchOrganization(req, req.body.organizationId) });
}

// Phone sign-in with a WhatsApp code (Phase 10E).
async function otpRequest(req, res) {
  res.json({ success: true, data: await otpService.requestLogin(req, req.body) });
}
async function otpVerify(req, res) {
  const { refreshToken, data } = await otpService.verifyLogin(req, req.body);
  setRefreshCookie(req, res, refreshToken);
  res.json({ success: true, data });
}
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

module.exports = { google, refresh, logout, me, switchOrganization, otpRequest, otpVerify, phoneStatus, phoneRequest, phoneVerify, phoneUnlink };
