const express = require('express');
const helpService = require('../services/helpService');
const { authenticate } = require('../middleware/auth');

// Help inside the CRM (D118): every member reads the platform's support contact for the "?" box
// and the help centre.
const router = express.Router();
router.use(authenticate);

router.get('/support', async (req, res) => {
  res.json({ success: true, data: await helpService.support(req) });
});

module.exports = router;
