const express = require('express');
const approvalService = require('../services/approvalService');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/approvals');

// Approval rules (Phase 1E, D77): owners and admins set them in Settings → Approvals; everyone
// who works on quotations (Leads or Deals) reads the active ones, so the editor can say "needs
// approval" before saving.
const router = express.Router();
const managers = requireRole('owner', 'admin');
const byId = validate({ params: idParams });

router.use(authenticate);

router.get('/', requirePermission(['leads', 'deals'], 'view'), validate({ query: schemas.ruleList }), async (req, res) => {
  res.json({ success: true, data: await approvalService.listRules(req, req.valid.query) });
});
router.post('/', managers, validate({ body: schemas.ruleCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await approvalService.createRule(req, req.body), message: 'Rule added' });
});
router.patch('/:id', managers, validate({ params: idParams, body: schemas.rulePatch }), async (req, res) => {
  res.json({ success: true, data: await approvalService.updateRule(req, req.valid.params.id, req.body), message: 'Rule saved' });
});
router.post('/:id/archive', managers, byId, async (req, res) => {
  res.json({ success: true, data: await approvalService.archiveRule(req, req.valid.params.id), message: 'Rule archived' });
});
router.post('/:id/restore', managers, byId, async (req, res) => {
  res.json({ success: true, data: await approvalService.restoreRule(req, req.valid.params.id), message: 'Rule restored' });
});

module.exports = router;
