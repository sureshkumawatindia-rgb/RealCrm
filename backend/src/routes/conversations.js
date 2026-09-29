const express = require('express');
const multer = require('multer');
const conversationService = require('../services/conversationService');
const httpError = require('../utils/httpError');
const { MEDIA_MAX_BYTES } = require('../constants/whatsapp');
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

// One file in the "file" field (WhatsApp's own limits per file type are checked by the service).
// utf8 keeps names like "बिल.pdf" intact.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEDIA_MAX_BYTES, files: 1, fields: 10 },
  defParamCharset: 'utf8',
});
function acceptFile(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') return next(httpError(413, 'FILE_TOO_LARGE', 'WhatsApp carries files up to 100 MB.'));
      return next(httpError(400, 'UPLOAD_ERROR', `Upload failed: ${error.message}`));
    }
    return next(error);
  });
}

router.use(authenticate);
router.get('/', can('view'), validate({ query: schemas.conversationList }), async (req, res) => {
  const { items, pagination } = await conversationService.list(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
router.get('/summary', can('view'), async (req, res) => {
  res.json({ success: true, data: await conversationService.summary(req) });
});
// Open (or find) the chat with a contact, e.g. to send a template first.
router.post('/', can('create'), validate({ body: schemas.conversationStart }), async (req, res) => {
  const { conversation, created } = await conversationService.start(req, req.body);
  res.status(created ? 201 : 200).json({ success: true, data: conversation });
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
  const send = req.body.type === 'template' ? conversationService.sendTemplate : conversationService.sendText;
  res.status(201).json({ success: true, data: await send(req, req.valid.params.id, req.body) });
});
// A file in the "file" field, with an optional caption. The file is read before the
// Idempotency-Key check so a retry of the same file is recognised.
router.post('/:id/messages/media', can('create'), acceptFile, idempotency, validate({ params: idParams, body: schemas.mediaSend }), async (req, res) => {
  res.status(201).json({ success: true, data: await conversationService.sendMedia(req, req.valid.params.id, req.body, req.file) });
});
// Always a download, never shown inline (a customer's file could be HTML or SVG). The page
// turns photos, audio and video into previews itself.
router.get('/:id/messages/:messageId/media', can('view'), validate({ params: schemas.messageParams }), async (req, res) => {
  const { stream, fileName } = await conversationService.openMedia(req, req.valid.params.id, req.valid.params.messageId);
  res.attachment(fileName);
  res.type('application/octet-stream');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, no-store');
  stream.on('error', (error) => res.destroy(error));
  stream.pipe(res);
});
router.get('/:id/notes', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await conversationService.listNotes(req, req.valid.params.id) });
});
router.post('/:id/notes', can('edit'), validate({ params: idParams, body: schemas.noteCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await conversationService.addNote(req, req.valid.params.id, req.body), message: 'Note added' });
});

module.exports = router;
