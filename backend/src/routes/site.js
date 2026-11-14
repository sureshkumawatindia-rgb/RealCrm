const express = require('express');
const env = require('../config/env');
const planService = require('../services/planService');
const helpService = require('../services/helpService');
const { CRM_TYPE_IDS, DEFAULT_CRM_TYPE, CRM_TYPE_SETUPS } = require('../constants/crmTypes');
const { KITS } = require('../constants/businessKits');

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

// Public: what each CRM type sets up (D146), for its own home page (index.html?crm=<id>). Read from
// the same set-ups and kits a company gets when it chooses the type, so the page never promises
// more than the CRM adds. Names only, in English and Hindi; "business" is the CRM as it is.
const words = (value) => ({ en: value.en, hi: value.hi });
const crmTypeSummaries = CRM_TYPE_IDS.filter((id) => id !== DEFAULT_CRM_TYPE).map((id) => {
  const kit = KITS[id] || {};
  const setup = CRM_TYPE_SETUPS[id] || {};
  return {
    id,
    about: kit.about ? words(kit.about) : null,
    stages: (kit.stages || []).map((stage) => words(stage.name)),
    quickReplies: (kit.quickReplies || []).map((reply) => words(reply.title)),
    products: (setup.products || []).map((product) => words(product.name)),
    fields: (setup.fields || []).filter((field) => field.object === 'lead').map((field) => words(field.label)),
    records: (setup.records || []).map((record) => words(record.plural)),
    templates: (setup.projectTemplates || []).map((template) => words(template.name)),
  };
});
router.get('/crm-types', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ success: true, data: crmTypeSummaries });
});

module.exports = router;
