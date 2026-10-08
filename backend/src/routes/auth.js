const express = require('express');
const controller = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { authLimiter, qrPollLimiter } = require('../middleware/rateLimit');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/auth');

const router = express.Router();

router.post('/google', authLimiter, validate({ body: schemas.googleLogin }), controller.google);
router.post('/refresh', authLimiter, controller.refresh);
router.post('/logout', authLimiter, controller.logout);
router.get('/me', authenticate, controller.me);
router.post('/switch-organization', authenticate, validate({ body: schemas.switchOrganization }), controller.switchOrganization);
// After Google: the mobile number and a WhatsApp code (D58).
router.post('/login/code', authLimiter, validate({ body: schemas.loginCode }), controller.loginCode);
router.post('/login/verify', authLimiter, validate({ body: schemas.loginVerify }), controller.loginVerify);
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

module.exports = router;
