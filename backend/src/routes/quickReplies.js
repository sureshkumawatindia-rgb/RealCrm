const express = require('express');
const quickReplyService = require('../services/quickReplyService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/inbox');

// Saved inbox answers: every inbox member can use and add them; deleting follows inbox:delete.
const router = express.Router();
const can = (action) => requirePermission('inbox', action);

router.use(authenticate);
router.get('/', can('view'), async (req, res) => {
  res.json({ success: true, data: await quickReplyService.list(req) });
});
router.post('/', can('create'), validate({ body: schemas.quickReplyCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await quickReplyService.create(req, req.body), message: 'Quick reply saved' });
});
router.patch('/:id', can('edit'), validate({ params: idParams, body: schemas.quickReplyPatch }), async (req, res) => {
  res.json({ success: true, data: await quickReplyService.update(req, req.valid.params.id, req.body), message: 'Quick reply updated' });
});
router.delete('/:id', can('delete'), validate({ params: idParams }), async (req, res) => {
  await quickReplyService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Quick reply deleted' });
});

module.exports = router;
