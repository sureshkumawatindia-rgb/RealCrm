const express = require('express');
const customFieldService = require('../services/customFieldService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/customFields');

// Custom fields (Phase 1A, D73). Anyone who can view customers (or leads/deals) reads the active
// fields; owners and admins manage them in Settings → Custom fields.
const router = express.Router();
const managers = requireRole('owner', 'admin');
const byId = validate({ params: idParams });

router.use(authenticate);

router.get('/', validate({ query: schemas.fieldList }), async (req, res) => {
  res.json({ success: true, data: await customFieldService.list(req, req.valid.query) });
});
router.post('/', managers, validate({ body: schemas.fieldCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await customFieldService.create(req, req.body), message: 'Field added' });
});
router.post('/reorder', managers, validate({ body: schemas.fieldReorder }), async (req, res) => {
  res.json({ success: true, data: await customFieldService.reorder(req, req.body), message: 'Order saved' });
});
router.patch('/:id', managers, validate({ params: idParams, body: schemas.fieldPatch }), async (req, res) => {
  res.json({ success: true, data: await customFieldService.update(req, req.valid.params.id, req.body), message: 'Field updated' });
});
router.post('/:id/archive', managers, byId, async (req, res) => {
  res.json({ success: true, data: await customFieldService.archive(req, req.valid.params.id), message: 'Field archived' });
});
router.post('/:id/restore', managers, byId, async (req, res) => {
  res.json({ success: true, data: await customFieldService.restore(req, req.valid.params.id), message: 'Field restored' });
});

module.exports = router;
