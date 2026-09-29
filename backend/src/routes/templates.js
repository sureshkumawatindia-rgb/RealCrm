const express = require('express');
const templateService = require('../services/templateService');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/whatsapp');

// WhatsApp message templates. Inbox members read them (the template picker); owners and
// admins sync, create and delete them (Settings → WhatsApp).
const router = express.Router();
const managers = requireRole('owner', 'admin');

router.use(authenticate);
router.get('/', requirePermission('inbox', 'view'), validate({ query: schemas.templateList }), async (req, res) => {
  res.json({ success: true, data: await templateService.list(req, req.valid.query) });
});
router.post('/sync', managers, validate({ body: schemas.templateSync }), async (req, res) => {
  res.json({ success: true, data: await templateService.sync(req, req.body), message: 'Templates synced' });
});
router.post('/', managers, validate({ body: schemas.templateCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await templateService.create(req, req.body), message: 'Template sent to Meta for approval' });
});
router.delete('/:id', managers, validate({ params: idParams }), async (req, res) => {
  await templateService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Template deleted' });
});

module.exports = router;
