const express = require('express');
const segmentService = require('../services/segmentService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/marketing');

// Saved audiences for WhatsApp broadcasts (Phase 7): owners and admins, like the other settings
// that message many customers at once.
const router = express.Router();
router.use(authenticate, requireRole('owner', 'admin'));

router.get('/', async (req, res) => {
  res.json({ success: true, data: await segmentService.list(req) });
});
// What the builder offers, and a count for filters not saved yet (before /:id).
router.get('/options', async (req, res) => {
  res.json({ success: true, data: await segmentService.options(req) });
});
router.post('/preview', validate({ body: schemas.segmentPreview }), async (req, res) => {
  res.json({ success: true, data: await segmentService.preview(req, req.body.filters) });
});
router.post('/', validate({ body: schemas.segmentCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await segmentService.create(req, req.body), message: 'Segment saved' });
});
router.get('/:id', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await segmentService.get(req, req.valid.params.id) });
});
router.get('/:id/preview', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await segmentService.previewSaved(req, req.valid.params.id) });
});
router.patch('/:id', validate({ params: idParams, body: schemas.segmentPatch }), async (req, res) => {
  res.json({ success: true, data: await segmentService.update(req, req.valid.params.id, req.body), message: 'Segment saved' });
});
router.delete('/:id', validate({ params: idParams }), async (req, res) => {
  await segmentService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Segment deleted' });
});

module.exports = router;
