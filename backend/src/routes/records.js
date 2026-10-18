const express = require('express');
const customRecordService = require('../services/customRecordService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/customFields');

// Records of the company's own objects (Phase 1C, D75), with the Customers module's permissions.
const router = express.Router();
const can = (action) => requirePermission('customers', action);
const byId = validate({ params: idParams });

router.use(authenticate);
router.get('/', can('view'), validate({ query: schemas.recordList }), async (req, res) => {
  const { items, pagination } = await customRecordService.list(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
router.post('/', can('create'), validate({ body: schemas.recordCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await customRecordService.create(req, req.body), message: 'Record added' });
});
router.get('/:id', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await customRecordService.get(req, req.valid.params.id) });
});
router.patch('/:id', can('edit'), validate({ params: idParams, body: schemas.recordPatch }), async (req, res) => {
  res.json({ success: true, data: await customRecordService.update(req, req.valid.params.id, req.body), message: 'Record updated' });
});
router.delete('/:id', can('delete'), byId, async (req, res) => {
  await customRecordService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Record deleted' });
});

module.exports = router;
