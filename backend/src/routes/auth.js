const express = require('express');
const controller = require('../controllers/authController');
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

module.exports = router;
