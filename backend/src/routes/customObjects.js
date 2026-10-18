const express = require('express');
const customObjectService = require('../services/customObjectService');
const lookupService = require('../services/lookupService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/customFields');

// The company's own objects (Phase 1C, D75), and the link picker. Anyone who can view customers
// reads the active objects; owners and admins manage them in Settings → Custom fields.
const objectRoutes = express.Router();
const managers = requireRole('owner', 'admin');
const byId = validate({ params: idParams });

objectRoutes.use(authenticate);
objectRoutes.get('/', validate({ query: schemas.objectList }), async (req, res) => {
  res.json({ success: true, data: await customObjectService.list(req, req.valid.query) });
});
objectRoutes.post('/', managers, validate({ body: schemas.objectCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await customObjectService.create(req, req.body), message: 'Object added' });
});
objectRoutes.post('/reorder', managers, validate({ body: schemas.objectReorder }), async (req, res) => {
  res.json({ success: true, data: await customObjectService.reorder(req, req.body), message: 'Order saved' });
});
objectRoutes.patch('/:id', managers, validate({ params: idParams, body: schemas.objectPatch }), async (req, res) => {
  res.json({ success: true, data: await customObjectService.update(req, req.valid.params.id, req.body), message: 'Object updated' });
});
objectRoutes.post('/:id/archive', managers, byId, async (req, res) => {
  res.json({ success: true, data: await customObjectService.archive(req, req.valid.params.id), message: 'Object archived' });
});
objectRoutes.post('/:id/restore', managers, byId, async (req, res) => {
  res.json({ success: true, data: await customObjectService.restore(req, req.valid.params.id), message: 'Object restored' });
});

// GET /lookup?target=contact|lead|x_…&q= — the records a link field can point to (the picker).
const lookupRoutes = express.Router();
lookupRoutes.use(authenticate);
lookupRoutes.get('/', validate({ query: schemas.lookupQuery }), async (req, res) => {
  res.json({ success: true, data: await lookupService.search(req, req.valid.query) });
});

module.exports = { objectRoutes, lookupRoutes };
