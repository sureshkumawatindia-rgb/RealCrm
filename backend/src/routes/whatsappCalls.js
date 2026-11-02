const express = require('express');
const calls = require('../services/whatsappCallService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/whatsappCalls');

// WhatsApp calls from the Inbox (G7, D111): answering or declining a customer's call, calling a
// customer who allowed it, asking them for that, hanging up. Only in chats the member sees.
const router = express.Router();
const can = (action) => requirePermission('inbox', action);
const byId = validate({ params: idParams });
router.use(authenticate);

router.get('/ringing', can('view'), async (req, res) => {
  res.json({ success: true, data: await calls.ringing(req) });
});
router.post('/', can('create'), validate({ body: schemas.place }), async (req, res) => {
  res.status(201).json({ success: true, data: await calls.place(req, req.valid.body) });
});
router.post('/permission', can('create'), validate({ body: schemas.permission }), async (req, res) => {
  res.status(201).json({ success: true, data: await calls.askPermission(req, req.valid.body) });
});
router.get('/:id', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await calls.get(req, req.valid.params.id) });
});
router.post('/:id/answer', can('create'), validate({ params: idParams, body: schemas.answer }), async (req, res) => {
  res.json({ success: true, data: await calls.answer(req, req.valid.params.id, req.valid.body) });
});
router.post('/:id/decline', can('create'), byId, async (req, res) => {
  res.json({ success: true, data: await calls.decline(req, req.valid.params.id) });
});
router.post('/:id/end', can('create'), byId, async (req, res) => {
  res.json({ success: true, data: await calls.end(req, req.valid.params.id) });
});

module.exports = router;
