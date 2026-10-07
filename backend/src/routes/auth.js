const express = require('express');
const controller = require('../controllers/authController');
const otpService = require('../services/otpService');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const validate = require('../middleware/validate');
const schemas = require('../validators/auth');

const router = express.Router();

router.post('/google', authLimiter, validate({ body: schemas.googleLogin }), controller.google);
router.post('/refresh', authLimiter, controller.refresh);
router.post('/logout', authLimiter, controller.logout);
router.get('/me', authenticate, controller.me);
router.post('/switch-organization', authenticate, validate({ body: schemas.switchOrganization }), controller.switchOrganization);
// Phone sign-in with a WhatsApp code (Phase 10E): the login page, and one's own number.
router.get('/otp/available', (req, res) => res.json({ success: true, data: { available: otpService.available() } }));
router.post('/otp/request', authLimiter, validate({ body: schemas.otpRequest }), controller.otpRequest);
router.post('/otp/verify', authLimiter, validate({ body: schemas.otpVerify }), controller.otpVerify);
router.get('/phone', authenticate, controller.phoneStatus);
router.post('/phone/request', authLimiter, authenticate, validate({ body: schemas.otpRequest }), controller.phoneRequest);
router.post('/phone/verify', authLimiter, authenticate, validate({ body: schemas.otpVerify }), controller.phoneVerify);
router.delete('/phone', authenticate, controller.phoneUnlink);

module.exports = router;
