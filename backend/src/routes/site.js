const express = require('express');
const env = require('../config/env');
const planService = require('../services/planService');
const helpService = require('../services/helpService');

// Public: who runs this CRM, for the legal pages — Privacy Policy and Terms of Service (D60; Meta's
// App Review needs both), and the Refund, Delivery and Contact pages that Razorpay's website check
// asks for. The business details print on the plan invoices too (BILLING_SELLER_*); the support
// WhatsApp, email and hours are the ones set on the platform admin page (D118).
const router = express.Router();

router.get('/', async (req, res) => {
  const seller = env.billing.seller;
  const support = await helpService.getSupport();
  res.json({
    success: true,
    data: {
      name: seller.name || 'AgreemCRM',
      email: seller.email || '',
      address: seller.address || '',
      gstin: seller.gstin || '',
      publicUrl: env.publicUrl,
      support: { whatsapp: support.whatsapp, email: support.email, hours: support.hours },
    },
  });
});

// Public: the plans for the home page (CP4), the same list signed-in owners see, from
// constants/plans.js only. Nothing about any company; browsers may keep it for 5 minutes.
router.get('/plans', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ success: true, data: planService.plans() });
});

module.exports = router;
