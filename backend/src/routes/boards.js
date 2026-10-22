const express = require('express');
const boardService = require('../services/boardService');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/boards');

// Boards (Phase 7B, D87): saved table, Kanban and calendar views of leads and tasks. The service
// checks the module of each board's object (leads or tasks), since one route serves both.
const router = express.Router();
router.use(authenticate);

router.get('/meta', async (req, res) => {
  res.json({ success: true, data: await boardService.meta(req) });
});
router.get('/', validate({ query: schemas.boardList }), async (req, res) => {
  res.json({ success: true, data: await boardService.list(req, req.valid.query) });
});
router.post('/', validate({ body: schemas.boardCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await boardService.create(req, req.body), message: 'Board saved' });
});
router.get('/:id', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await boardService.get(req, req.valid.params.id) });
});
router.patch('/:id', validate({ params: idParams, body: schemas.boardPatch }), async (req, res) => {
  res.json({ success: true, data: await boardService.update(req, req.valid.params.id, req.body), message: 'Board saved' });
});
router.delete('/:id', validate({ params: idParams }), async (req, res) => {
  await boardService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Board deleted' });
});
router.get('/:id/items', validate({ params: idParams, query: schemas.boardItems }), async (req, res) => {
  res.json({ success: true, data: await boardService.items(req, req.valid.params.id, req.valid.query) });
});

module.exports = router;
