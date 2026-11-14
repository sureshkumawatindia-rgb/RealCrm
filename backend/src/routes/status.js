const express = require('express');
const serviceStatus = require('../services/serviceStatusService');
const { authenticate } = require('../middleware/auth');

// Is the CRM working? (Phase 9, D151; docs/RELIABILITY.md.) GET /status is public: the status page
// here, and the watchdog's page outside the CRM, read it. It says nothing about any company.
// GET /status/notices is for the banners inside the CRM: what matters to this company now.
const router = express.Router();

router.get('/', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=30');
  res.json({ success: true, data: await serviceStatus.publicStatus() });
});

router.get('/notices', authenticate, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json({ success: true, data: await serviceStatus.noticesFor(req.tenant.organizationId) });
});

module.exports = router;
