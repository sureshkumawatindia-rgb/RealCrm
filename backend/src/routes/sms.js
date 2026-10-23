const express = require('express');
const smsService = require('../services/smsService');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireRole } = require('../middleware/permissions');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const schemas = require('../validators/sms');

// SMS to customers (Phase 8A, D88). The connection is the owners' and admins' (Settings → SMS);
// everyone with Customers sees the templates, and with Customers edit may send. A send takes an
// Idempotency-Key: the same key never sends twice.
const router = express.Router();
router.use(authenticate);
const managers = requireRole('owner', 'admin');

router.get('/connection', async (req, res) => {
  res.json({ success: true, data: await smsService.getConnection(req) });
});
router.put('/connection', managers, validate({ body: schemas.connectionSave }), async (req, res) => {
  res.json({ success: true, data: await smsService.saveConnection(req, req.body), message: 'SMS account saved' });
});
router.post('/connection/test', managers, async (req, res) => {
  res.json({ success: true, data: await smsService.testConnection(req) });
});
router.delete('/connection', managers, async (req, res) => {
  res.json({ success: true, data: await smsService.removeConnection(req) });
});
router.get('/', requirePermission('customers', 'view'), validate({ query: schemas.smsList }), async (req, res) => {
  res.json({ success: true, data: await smsService.list(req, req.valid.query) });
});
router.post('/', requirePermission('customers', 'edit'), idempotency, validate({ body: schemas.smsSend }), async (req, res) => {
  const key = req.get('Idempotency-Key');
  const message = await smsService.send(req, req.body, key ? `manual:${req.member._id}:${key}` : undefined);
  res.status(201).json({ success: true, data: message, message: 'SMS sent' });
});

module.exports = router;
