const express = require('express');
const Joi = require('joi');
const Organization = require('../models/Organization');
const aiService = require('../services/aiService');
const planService = require('../services/planService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');

// The AI assistant (Phase 10D). /ai/status for every member (does the inbox show "Suggest a
// reply"?); the settings, the usage and the test box for owners and admins.
const router = express.Router();
router.use(authenticate);
const managers = requireRole('owner', 'admin');

const settingsSchema = Joi.object({
  enabled: Joi.boolean(),
  autoReply: Joi.boolean(),
  instructions: Joi.string().trim().max(1500).allow(''),
}).min(1);
const testSchema = Joi.object({ message: Joi.string().trim().min(1).max(1000).required() });

router.get('/status', async (req, res) => {
  const organization = await Organization.findById(req.tenant.organizationId).select('ai subscription plan');
  const available = aiService.configured() && Boolean(organization.ai?.enabled) && !planService.subscriptionOf(organization).locked;
  res.json({ success: true, data: { available, autoReply: available && Boolean(organization.ai?.autoReply) } });
});
router.get('/settings', managers, async (req, res) => {
  res.json({ success: true, data: await aiService.settings(req) });
});
router.put('/settings', managers, validate({ body: settingsSchema }), async (req, res) => {
  res.json({ success: true, data: await aiService.saveSettings(req, req.body), message: 'AI assistant saved' });
});
router.post('/test', managers, validate({ body: testSchema }), async (req, res) => {
  res.json({ success: true, data: await aiService.test(req, req.body) });
});

module.exports = router;
