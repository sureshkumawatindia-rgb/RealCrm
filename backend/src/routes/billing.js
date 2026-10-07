const express = require('express');
const planService = require('../services/planService');
const billingService = require('../services/billingService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/billing');

// The SaaS plan (Phase 10): the plans on offer, and this organization's plan, trial or
// subscription and (owners and admins) its usage. Every member reads it: the trial banner and
// the upgrade prompts show on every page. Paying, changing, cancelling and the GST invoices are
// for owners and admins.
const router = express.Router();
router.use(authenticate);
const managers = requireRole('owner', 'admin');

router.get('/plans', (req, res) => {
  res.json({ success: true, data: planService.plans() });
});
router.get('/subscription', async (req, res) => {
  res.json({ success: true, data: { ...(await planService.summary(req)), billing: billingService.publicStatus() } });
});

router.post('/checkout', managers, validate({ body: schemas.checkout }), async (req, res) => {
  res.json({ success: true, data: await billingService.checkout(req, req.body) });
});
router.post('/subscription/cancel', managers, async (req, res) => {
  res.json({ success: true, data: await billingService.cancel(req), message: 'Plan cancelled' });
});
router.post('/subscription/refresh', managers, async (req, res) => {
  res.json({ success: true, data: await billingService.refresh(req) });
});

router.get('/invoices', managers, async (req, res) => {
  res.json({ success: true, data: await billingService.listInvoices(req) });
});
router.get('/invoices/:id/pdf', managers, validate({ params: idParams }), async (req, res) => {
  const { buffer, fileName } = await billingService.invoicePdf(req, req.valid.params.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
});

module.exports = router;
