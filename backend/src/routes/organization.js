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
const gettingStarted = require('../services/gettingStartedService');
const { CHOOSABLE_KIT_IDS, KIT_LANGUAGES } = require('../constants/businessKits');
const Organization = require('../models/Organization');
const Joi = require('joi');
const { HIDEABLE_MODULES } = require('../constants/permissions');
const privacy = require('../services/privacyService');
const privacySchemas = require('../validators/privacy');

const router = express.Router();
// One logo file and nothing else (Phase 1 security review: no unlimited form fields).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5, fieldSize: 1024 },
});

function uploadLogo(req, res, next) {
  upload.single('logo')(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      return next(Object.assign(error, {
        statusCode: 400,
        code: tooLarge ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR',
        message: tooLarge ? 'File size must be less than 2 MB.' : 'Send one logo image in the "logo" field.',
      }));
    }
    return next(error);
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
// hiddenModules (D76): the whole list of pages the company does not use; Dashboard, Customers
// and Settings can never be hidden.
const settingsPatch = Joi.object({
  hidePhonesFromAgents: Joi.boolean(),
  sendReadReceipts: Joi.boolean(),
  // D103: "How was our service?" after a resolved chat.
  csat: Joi.object({ enabled: Joi.boolean(), question: Joi.string().trim().max(500).allow('') }).min(1),
  hiddenModules: Joi.array().items(Joi.string().valid(...HIDEABLE_MODULES).messages({ 'any.only': 'Dashboard, Customers and Settings are always on.' })).unique().max(HIDEABLE_MODULES.length),
}).min(1);
router.patch('/settings', requireRole('owner', 'admin'), validate({ body: settingsPatch }), async (req, res) => {
  res.json({ success: true, data: await teamSettings.updateSettings(req, req.body), message: 'Settings saved' });
});
// First steps after sign-up (D64): "Invite your team".
router.get('/onboarding', requireRole('owner', 'admin'), async (req, res) => {
  res.json({ success: true, data: await teamSettings.onboarding(req) });
});
router.post('/onboarding/team', requireRole('owner', 'admin'), validate({ body: Joi.object({ skipped: Joi.boolean().default(false) }) }), async (req, res) => {
  res.json({ success: true, data: await teamSettings.finishTeamStep(req, req.body) });
});
// The first day (D117): the "Getting started" list, and ready settings for the business.
router.get('/getting-started', requireRole('owner', 'admin'), async (req, res) => {
  res.json({ success: true, data: await gettingStarted.status(req) });
});
router.patch('/getting-started', requireRole('owner', 'admin'), validate({ body: Joi.object({ hidden: Joi.boolean().required() }) }), async (req, res) => {
  res.json({ success: true, data: await gettingStarted.setHidden(req, req.body) });
});
router.get('/business-kits', requireRole('owner', 'admin'), validate({ query: Joi.object({ language: Joi.string().valid(...KIT_LANGUAGES) }) }), async (req, res) => {
  res.json({ success: true, data: await gettingStarted.kits(req, req.valid.query) });
});
router.post('/business-kit', requireRole('owner', 'admin'), validate({ body: Joi.object({ kit: Joi.string().valid(...CHOOSABLE_KIT_IDS).required(), language: Joi.string().valid(...KIT_LANGUAGES) }) }), async (req, res) => {
  res.json({ success: true, data: await gettingStarted.applyKit(req, req.body), message: 'Ready settings added' });
});
router.post('/logo', requireRole('owner', 'admin'), uploadLogo, controller.uploadLogo);
router.delete('/logo', requireRole('owner', 'admin'), controller.deleteLogo);

// Phase 8 (D120): the company's privacy settings, its customers' data requests, and finding the
// customer a request is about (deleted ones too).
router.get('/privacy', requireRole('owner', 'admin'), async (req, res) => {
  res.json({ success: true, data: await privacy.getSettings(req) });
});
router.put('/privacy', requireRole('owner', 'admin'), validate({ body: privacySchemas.settings }), async (req, res) => {
  res.json({ success: true, data: await privacy.updateSettings(req, req.body), message: 'Privacy settings saved' });
});
router.get('/privacy/requests', requireRole('owner', 'admin'), validate({ query: privacySchemas.requests }), async (req, res) => {
  const { items, pagination } = await privacy.requests(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
router.get('/privacy/customers', requireRole('owner', 'admin'), validate({ query: privacySchemas.find }), async (req, res) => {
  res.json({ success: true, data: await privacy.findCustomers(req, req.valid.query) });
});

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
