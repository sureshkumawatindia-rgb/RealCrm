const express = require('express');
const botService = require('../services/botService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/bot');

// The WhatsApp FAQ bot (Phase 6C): its answers and settings belong to owners and admins, like the
// other rules that write to customers (assignment and auto-reply rules).
const managers = requireRole('owner', 'admin');

const faqRuleRoutes = express.Router();
faqRuleRoutes.use(authenticate, managers);
faqRuleRoutes.get('/', async (req, res) => {
  res.json({ success: true, data: await botService.listRules(req) });
});
faqRuleRoutes.post('/', validate({ body: schemas.faqRuleCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await botService.createRule(req, req.body), message: 'Answer saved' });
});
faqRuleRoutes.patch('/:id', validate({ params: idParams, body: schemas.faqRulePatch }), async (req, res) => {
  res.json({ success: true, data: await botService.updateRule(req, req.valid.params.id, req.body), message: 'Answer saved' });
});
faqRuleRoutes.delete('/:id', validate({ params: idParams }), async (req, res) => {
  await botService.removeRule(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Answer deleted' });
});

const botRoutes = express.Router();
botRoutes.use(authenticate);
// Whether the bot is on (the Inbox shows it in each chat); every member may ask.
botRoutes.get('/status', async (req, res) => {
  res.json({ success: true, data: await botService.status(req) });
});
botRoutes.get('/settings', managers, async (req, res) => {
  res.json({ success: true, data: await botService.getSettings(req) });
});
botRoutes.put('/settings', managers, validate({ body: schemas.botSettings }), async (req, res) => {
  res.json({ success: true, data: await botService.saveSettings(req, req.body), message: 'Bot settings saved' });
});

module.exports = { faqRuleRoutes, botRoutes };
