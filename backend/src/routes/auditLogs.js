const express = require('express');
const Joi = require('joi');
const auditLogs = require('../services/auditLogService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { objectId } = require('../validators/common');
const { paginationQuery } = require('../utils/pagination');

// The audit log (Phase 10F): owners and admins.
const router = express.Router();
router.use(authenticate, requireRole('owner', 'admin'));

const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'Use a date like 2026-10-07.' });
const listQuery = Joi.object({
  ...paginationQuery,
  action: Joi.string().trim().max(80),
  entityType: Joi.string().trim().max(80),
  entityId: Joi.string().trim().max(80),
  actorUserId: objectId,
  from: day,
  to: day,
});

router.get('/', validate({ query: listQuery }), async (req, res) => {
  const { items, pagination } = await auditLogs.list(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
router.get('/meta', async (req, res) => {
  res.json({ success: true, data: await auditLogs.meta(req) });
});

module.exports = router;
