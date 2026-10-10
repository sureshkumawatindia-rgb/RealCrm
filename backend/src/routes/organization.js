const express = require('express');
const multer = require('multer');
const controller = require('../controllers/organizationController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { organizationPatch, billing: billingSchema } = require('../validators/organization');
const routingSchemas = require('../validators/routing');
const assignment = require('../services/assignmentService');
const organizationService = require('../services/organizationService');
const deletion = require('../services/organizationDeletionService');
const teamSettings = require('../services/teamSettingsService');
const Organization = require('../models/Organization');
const Joi = require('joi');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

function uploadLogo(req, res, next) {
  upload.single('logo')(req, res, (error) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      error.statusCode = 400;
      error.code = 'FILE_TOO_LARGE';
      error.message = 'File size must be less than 2 MB.';
    }
    next(error);
  });
}

router.use(authenticate);
router.get('/', controller.get);
// Working hours (assignment rules can send leads outside them to a fallback person).
router.get('/business-hours', async (req, res) => {
  res.json({ success: true, data: await assignment.getBusinessHours(req) });
});
router.put('/business-hours', requireRole('owner', 'admin'), validate({ body: routingSchemas.businessHours }), async (req, res) => {
  res.json({ success: true, data: await assignment.setBusinessHours(req, req.body), message: 'Working hours saved' });
});
// Quotation and order settings (bank, UPI, terms, prefixes); owners and admins.
router.get('/billing', requireRole('owner', 'admin'), async (req, res) => {
  res.json({ success: true, data: await organizationService.getBilling(req) });
});
router.put('/billing', requireRole('owner', 'admin'), validate({ body: billingSchema }), async (req, res) => {
  res.json({ success: true, data: await organizationService.setBilling(req, req.body), message: 'Billing settings saved' });
});
router.patch('/', requireRole('owner', 'admin'), validate({ body: organizationPatch }), controller.update);
// Company-wide team choices (D65: hide customers' numbers from agents); everyone reads them.
router.get('/settings', async (req, res) => {
  res.json({ success: true, data: await teamSettings.getSettings(req) });
});
router.patch('/settings', requireRole('owner', 'admin'), validate({ body: Joi.object({ hidePhonesFromAgents: Joi.boolean() }).min(1) }), async (req, res) => {
  res.json({ success: true, data: await teamSettings.updateSettings(req, req.body), message: 'Settings saved' });
});
// First steps after sign-up (D64): "Invite your team".
router.get('/onboarding', requireRole('owner', 'admin'), async (req, res) => {
  res.json({ success: true, data: await teamSettings.onboarding(req) });
});
router.post('/onboarding/team', requireRole('owner', 'admin'), validate({ body: Joi.object({ skipped: Joi.boolean().default(false) }) }), async (req, res) => {
  res.json({ success: true, data: await teamSettings.finishTeamStep(req, req.body) });
});
router.post('/logo', requireRole('owner', 'admin'), uploadLogo, controller.uploadLogo);
router.delete('/logo', requireRole('owner', 'admin'), controller.deleteLogo);

// Deleting the company (Phase 10F): owners ask (typing its name) and can cancel during the grace
// period; everyone can see that it is coming.
router.get('/deletion', async (req, res) => {
  const organization = await Organization.findById(req.tenant.organizationId).select('deletion');
  res.json({ success: true, data: deletion.statusOf(organization) });
});
router.delete('/', requireRole('owner'), validate({ body: Joi.object({ confirmName: Joi.string().trim().max(200).required() }) }), async (req, res) => {
  res.json({ success: true, data: await deletion.request(req, req.body), message: 'The company will be deleted after the waiting period' });
});
router.post('/deletion/cancel', requireRole('owner'), async (req, res) => {
  await deletion.cancel(req);
  res.json({ success: true, data: null, message: 'The company will not be deleted' });
});

module.exports = router;
