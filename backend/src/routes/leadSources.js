const express = require('express');
const leadSourceService = require('../services/leadSourceService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/leadSources');

// Settings → Lead sources: owners and admins connect the places leads come from.
const router = express.Router();
router.use(authenticate, requireRole('owner', 'admin'));

router.get('/', async (req, res) => {
  res.json({ success: true, data: await leadSourceService.list(req) });
});
router.post('/', validate({ body: schemas.connectionCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await leadSourceService.create(req, req.body), message: 'Lead source added' });
});
router.patch('/:id', validate({ params: idParams, body: schemas.connectionPatch }), async (req, res) => {
  res.json({ success: true, data: await leadSourceService.update(req, req.valid.params.id, req.body), message: 'Lead source updated' });
});
router.delete('/:id', validate({ params: idParams }), async (req, res) => {
  await leadSourceService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Lead source removed' });
});
// IndiaMART: pull at once (IndiaMART allows one pull every 5 minutes).
router.post('/:id/pull', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await leadSourceService.pull(req, req.valid.params.id) });
});
router.get('/:id/intakes', validate({ params: idParams, query: schemas.intakeList }), async (req, res) => {
  res.json({ success: true, data: await leadSourceService.intakes(req, req.valid.params.id, req.valid.query) });
});

module.exports = router;
