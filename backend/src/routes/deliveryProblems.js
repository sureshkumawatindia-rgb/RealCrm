const express = require('express');
const Joi = require('joi');
const deliveryProblems = require('../services/deliveryProblemsService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');

// Settings → Failed sends (Phase 9, D151): owners and admins.
const router = express.Router();
router.use(authenticate, requireRole('owner', 'admin'));

const listQuery = Joi.object({
  kind: Joi.string().valid('all', ...deliveryProblems.KINDS).default('all'),
  page: Joi.number().integer().min(1).max(100).default(1),
  limit: Joi.number().integer().min(1).max(100).default(30),
});
const retryParams = Joi.object({
  kind: Joi.string().valid('chat', 'sms', 'webhook').required(),
  id: Joi.string().hex().length(24).required(),
});

router.get('/', validate({ query: listQuery }), async (req, res) => {
  const { items, summary, pagination } = await deliveryProblems.list(req, req.valid.query);
  res.json({ success: true, data: items, summary, pagination });
});
router.post('/:kind/:id/retry', validate({ params: retryParams }), async (req, res) => {
  res.json({ success: true, data: await deliveryProblems.retry(req, req.valid.params.kind, req.valid.params.id) });
});

module.exports = router;
