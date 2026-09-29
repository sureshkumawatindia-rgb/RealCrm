const express = require('express');
const assignment = require('../services/assignmentService');
const autoReply = require('../services/autoReplyService');
const leadService = require('../services/leadService');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/routing');

// Assignment rules and auto-reply rules (Settings, owners and admins); the assignment history
// of a lead for anyone who may open Leads.
const assignmentRoutes = express.Router();
assignmentRoutes.use(authenticate);
assignmentRoutes.get('/history', requirePermission(leadService.MODULES, 'view'), validate({ query: schemas.historyQuery }), async (req, res) => {
  res.json({ success: true, data: await assignment.history(req, req.valid.query.leadId) });
});
assignmentRoutes.use(requireRole('owner', 'admin'));
assignmentRoutes.get('/', async (req, res) => {
  res.json({ success: true, data: await assignment.listRules(req) });
});
assignmentRoutes.post('/', validate({ body: schemas.assignmentRuleCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await assignment.createRule(req, req.body), message: 'Assignment rule added' });
});
assignmentRoutes.patch('/:id', validate({ params: idParams, body: schemas.assignmentRulePatch }), async (req, res) => {
  res.json({ success: true, data: await assignment.updateRule(req, req.valid.params.id, req.body), message: 'Assignment rule updated' });
});
assignmentRoutes.delete('/:id', validate({ params: idParams }), async (req, res) => {
  await assignment.removeRule(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Assignment rule removed' });
});

const autoReplyRoutes = express.Router();
autoReplyRoutes.use(authenticate, requireRole('owner', 'admin'));
autoReplyRoutes.get('/', async (req, res) => {
  res.json({ success: true, data: await autoReply.listRules(req) });
});
autoReplyRoutes.post('/', validate({ body: schemas.autoReplyRuleCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await autoReply.createRule(req, req.body), message: 'Auto-reply rule added' });
});
autoReplyRoutes.patch('/:id', validate({ params: idParams, body: schemas.autoReplyRulePatch }), async (req, res) => {
  res.json({ success: true, data: await autoReply.updateRule(req, req.valid.params.id, req.body), message: 'Auto-reply rule updated' });
});
autoReplyRoutes.delete('/:id', validate({ params: idParams }), async (req, res) => {
  await autoReply.removeRule(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Auto-reply rule removed' });
});

module.exports = { assignmentRoutes, autoReplyRoutes };
