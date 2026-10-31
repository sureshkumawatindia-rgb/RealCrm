const express = require('express');
const controller = require('../controllers/authController');
const authService = require('../services/authService');
const { authenticate } = require('../middleware/auth');
const { authLimiter, qrPollLimiter, workspaceLimiter } = require('../middleware/rateLimit');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/auth');

const router = express.Router();

// The company typed on the login card, checked before Google (D66).
router.post('/workspace', workspaceLimiter, validate({ body: schemas.workspaceLookup }), controller.workspace);
router.post('/google', authLimiter, validate({ body: schemas.googleLogin }), controller.google);
router.post('/refresh', authLimiter, controller.refresh);
router.post('/logout', authLimiter, controller.logout);
router.get('/me', authenticate, controller.me);
router.post('/switch-organization', authenticate, validate({ body: schemas.switchOrganization }), controller.switchOrganization);
// After Google: the mobile number and a WhatsApp code (D58).
router.post('/login/code', authLimiter, validate({ body: schemas.loginCode }), controller.loginCode);
router.post('/login/verify', authLimiter, validate({ body: schemas.loginVerify }), controller.loginVerify);
// Or the authenticator app's code (F7).
router.post('/login/app', authLimiter, validate({ body: schemas.loginApp }), controller.loginApp);
// Logging in a computer by scanning its QR code with the phone (D58).
router.post('/qr', authLimiter, controller.qrStart);
router.post('/qr/:id/poll', qrPollLimiter, validate({ params: idParams, body: schemas.qrPoll }), controller.qrPoll);
router.post('/qr/:id/peek', authenticate, validate({ params: idParams, body: schemas.qrSecret }), controller.qrPeek);
router.post('/qr/:id/approve', authenticate, validate({ params: idParams, body: schemas.qrApprove }), controller.qrApprove);
// Where you're logged in (Settings → Your Profile), like WhatsApp's linked devices.
router.get('/devices', authenticate, controller.devices);
router.post('/devices/logout-others', authenticate, controller.devicesLogOutOthers);
router.delete('/devices/:id', authenticate, validate({ params: schemas.deviceParams }), controller.deviceLogOut);
// One's own WhatsApp number (Settings → Your Profile).
router.get('/phone', authenticate, controller.phoneStatus);
router.post('/phone/request', authLimiter, authenticate, validate({ body: schemas.otpRequest }), controller.phoneRequest);
router.post('/phone/verify', authLimiter, authenticate, validate({ body: schemas.otpVerify }), controller.phoneVerify);
router.delete('/phone', authenticate, controller.phoneUnlink);
// 2-step verification: the WhatsApp code after Google on a new browser (optional, D60).
router.put('/two-step', authenticate, validate({ body: schemas.twoStep }), controller.twoStep);
// 2-step login with an authenticator app (F7): status, set up, turn on, new backup codes, off.
router.get('/totp', authenticate, controller.totpStatus);
router.post('/totp/setup', authenticate, controller.totpSetup);
router.post('/totp/enable', authLimiter, authenticate, validate({ body: schemas.totpCode }), controller.totpEnable);
router.post('/totp/backup-codes', authLimiter, authenticate, validate({ body: schemas.totpCode }), controller.totpBackupCodes);
router.post('/totp/disable', authLimiter, authenticate, validate({ body: schemas.totpCode }), controller.totpDisable);
// One's own language and theme, the same on every device (CP5).
router.patch('/preferences', authenticate, validate({ body: schemas.preferences }), controller.preferences);
// D104: also email the new-login alert (on by default).
router.get('/login-alerts', authenticate, (req, res) => {
  res.json({ success: true, data: authService.loginAlerts(req) });
});
router.patch('/login-alerts', authenticate, validate({ body: schemas.loginAlerts }), async (req, res) => {
  res.json({ success: true, data: await authService.updateLoginAlerts(req, req.body) });
});

module.exports = router;
