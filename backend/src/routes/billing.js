const express = require('express');
const planService = require('../services/planService');
const { authenticate } = require('../middleware/auth');

// The SaaS plan (Phase 10): the plans on offer, and this organization's plan, trial or
// subscription and (owners and admins) its usage. Every member reads it: the trial banner and
// the upgrade prompts show on every page.
const router = express.Router();
router.use(authenticate);

router.get('/plans', (req, res) => {
  res.json({ success: true, data: planService.plans() });
});
router.get('/subscription', async (req, res) => {
  res.json({ success: true, data: await planService.summary(req) });
});

module.exports = router;
