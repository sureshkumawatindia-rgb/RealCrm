const express = require('express');
const pipelineService = require('../services/pipelineService');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/pipelines');

// Pipelines (Phase 5, D84): everyone with the leads (or deals) module reads them and the board;
// owners and admins change them.
const router = express.Router();
router.use(authenticate);
const view = requirePermission(pipelineService.LEAD_MODULES, 'view');
const managers = requireRole('owner', 'admin');

router.get('/', view, async (req, res) => {
  res.json({ success: true, data: await pipelineService.list(req) });
});
router.post('/', managers, validate({ body: schemas.pipelineCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await pipelineService.create(req, req.body), message: 'Pipeline added' });
});
router.get('/:id', view, validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await pipelineService.get(req, req.valid.params.id) });
});
router.patch('/:id', managers, validate({ params: idParams, body: schemas.pipelinePatch }), async (req, res) => {
  res.json({ success: true, data: await pipelineService.update(req, req.valid.params.id, req.body), message: 'Pipeline saved' });
});
router.delete('/:id', managers, validate({ params: idParams, query: schemas.pipelineDelete }), async (req, res) => {
  res.json({ success: true, data: await pipelineService.remove(req, req.valid.params.id, req.valid.query), message: 'Pipeline deleted' });
});
router.get('/:id/board', view, validate({ params: idParams, query: schemas.board }), async (req, res) => {
  res.json({ success: true, data: await pipelineService.board(req, req.valid.params.id, req.valid.query) });
});
router.get('/:id/summary', view, validate({ params: idParams, query: schemas.board }), async (req, res) => {
  res.json({ success: true, data: await pipelineService.board(req, req.valid.params.id, req.valid.query, { cards: false }) });
});

module.exports = router;
