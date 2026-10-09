const express = require('express');
const env = require('../config/env');

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

module.exports = router;
