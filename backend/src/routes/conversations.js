const express = require('express');
const conversationService = require('../services/conversationService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const { noteCreate } = require('../validators/crm');
const schemas = { ...require('../validators/inbox'), noteCreate };

// The WhatsApp inbox (module "inbox"). Which chats a member sees: conversationService (D24).
const router = express.Router();
const can = (action) => requirePermission('inbox', action);
const byId = validate({ params: idParams });

router.use(authenticate);
router.get('/', can('view'), validate({ query: schemas.conversationList }), async (req, res) => {
  const { items, pagination } = await conversationService.list(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
router.get('/summary', can('view'), async (req, res) => {
  res.json({ success: true, data: await conversationService.summary(req) });
});
router.get('/:id', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await conversationService.get(req, req.valid.params.id) });
});
router.patch('/:id', can('edit'), validate({ params: idParams, body: schemas.conversationPatch }), async (req, res) => {
  res.json({ success: true, data: await conversationService.update(req, req.valid.params.id, req.body), message: 'Conversation updated' });
});
router.post('/:id/read', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await conversationService.markRead(req, req.valid.params.id) });
});
router.get('/:id/messages', can('view'), validate({ params: idParams, query: schemas.messageList }), async (req, res) => {
  const { items, hasMore, nextBefore } = await conversationService.listMessages(req, req.valid.params.id, req.valid.query);
  res.json({ success: true, data: items, hasMore, nextBefore });
});
// Idempotency-Key: a retried click sends the WhatsApp message once.
router.post('/:id/messages', can('create'), idempotency, validate({ params: idParams, body: schemas.messageSend }), async (req, res) => {
  res.status(201).json({ success: true, data: await conversationService.sendText(req, req.valid.params.id, req.body) });
});
router.get('/:id/notes', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await conversationService.listNotes(req, req.valid.params.id) });
});
router.post('/:id/notes', can('edit'), validate({ params: idParams, body: schemas.noteCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await conversationService.addNote(req, req.valid.params.id, req.body), message: 'Note added' });
});

module.exports = router;
