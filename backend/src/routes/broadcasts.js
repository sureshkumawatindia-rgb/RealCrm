const express = require('express');
const broadcastService = require('../services/broadcastService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/marketing');

// WhatsApp broadcasts (Phase 7): owners and admins (D36). Sending accepts an Idempotency-Key.
const router = express.Router();
const byId = validate({ params: idParams });
router.use(authenticate, requireRole('owner', 'admin'));

router.get('/', validate({ query: schemas.broadcastList }), async (req, res) => {
  const { items, pagination } = await broadcastService.list(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
// This month's broadcasts against the plan (before /:id).
router.get('/quota', async (req, res) => {
  res.json({ success: true, data: await broadcastService.quota(req) });
});
router.post('/', validate({ body: schemas.broadcastCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await broadcastService.create(req, req.body), message: 'Broadcast saved as a draft' });
});
router.get('/:id', byId, async (req, res) => {
  res.json({ success: true, data: await broadcastService.get(req, req.valid.params.id) });
});
router.patch('/:id', validate({ params: idParams, body: schemas.broadcastPatch }), async (req, res) => {
  res.json({ success: true, data: await broadcastService.update(req, req.valid.params.id, req.body), message: 'Broadcast saved' });
});
router.delete('/:id', byId, async (req, res) => {
  await broadcastService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Broadcast deleted' });
});
router.get('/:id/estimate', byId, async (req, res) => {
  res.json({ success: true, data: await broadcastService.estimate(req, req.valid.params.id) });
});
router.post('/:id/send', idempotency, validate({ params: idParams, body: schemas.broadcastSend }), async (req, res) => {
  const broadcast = await broadcastService.send(req, req.valid.params.id, req.body);
  res.json({ success: true, data: broadcast, message: new Date(broadcast.scheduledAt) > new Date(Date.now() + 5000) ? 'Broadcast scheduled' : 'Broadcast started' });
});
router.post('/:id/cancel', byId, async (req, res) => {
  res.json({ success: true, data: await broadcastService.cancel(req, req.valid.params.id), message: 'Broadcast cancelled' });
});
router.post('/:id/pause', byId, async (req, res) => {
  res.json({ success: true, data: await broadcastService.pause(req, req.valid.params.id), message: 'Broadcast paused' });
});
router.post('/:id/resume', byId, async (req, res) => {
  res.json({ success: true, data: await broadcastService.resume(req, req.valid.params.id), message: 'Broadcast resumed' });
});
router.get('/:id/recipients', validate({ params: idParams, query: schemas.recipientList }), async (req, res) => {
  const { items, pagination } = await broadcastService.recipients(req, req.valid.params.id, req.valid.query);
  res.json({ success: true, data: items, pagination });
});

module.exports = router;
