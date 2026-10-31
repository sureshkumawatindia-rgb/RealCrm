const express = require('express');
const platformService = require('../services/platformService');
const emailService = require('../services/emailService');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/platform');

// The platform admin page (D104): only the emails in PLATFORM_ADMIN_EMAILS with the
// authenticator app, after a code on this login (30 minutes). Others get 404.
const router = express.Router();

router.use(authenticate);
router.get('/status', async (req, res) => {
  res.json({ success: true, data: await platformService.status(req) });
});
router.post('/unlock', authLimiter, validate({ body: schemas.unlock }), async (req, res) => {
  res.json({ success: true, data: await platformService.unlock(req, req.body), message: 'Platform admin page open for 30 minutes' });
});
router.post('/lock', async (req, res) => {
  res.json({ success: true, data: await platformService.lock(req) });
});

router.use(platformService.requireAdmin);
router.get('/overview', async (req, res) => {
  res.json({ success: true, data: await platformService.overview() });
});
router.get('/companies', validate({ query: schemas.companies }), async (req, res) => {
  res.json({ success: true, data: await platformService.companies(req.valid.query) });
});
router.post('/companies/:id/actions', validate({ params: idParams, body: schemas.action }), async (req, res) => {
  res.json({ success: true, data: await platformService.act(req, req.valid.params.id, req.body), message: 'Done' });
});
router.get('/emails', validate({ query: schemas.emails }), async (req, res) => {
  res.json({ success: true, data: await emailService.stats(req.valid.query) });
});
router.get('/checklist', async (req, res) => {
  res.json({ success: true, data: platformService.checklist() });
});

module.exports = router;
