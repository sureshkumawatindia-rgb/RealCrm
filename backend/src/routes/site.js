const express = require('express');
const env = require('../config/env');
const planService = require('../services/planService');

// Public: who runs this CRM, for the Privacy Policy and Terms of Service pages (D60; Meta's App
// Review needs both). The same details print on the plan invoices (BILLING_SELLER_*).
const router = express.Router();

router.get('/', (req, res) => {
  const seller = env.billing.seller;
  res.json({
    success: true,
    data: { name: seller.name || 'YELLOW CRM', email: seller.email || '', address: seller.address || '', publicUrl: env.publicUrl },
  });
});

// Public: the plans for the home page (CP4), the same list signed-in owners see, from
// constants/plans.js only. Nothing about any company; browsers may keep it for 5 minutes.
router.get('/plans', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ success: true, data: planService.plans() });
});

module.exports = router;
