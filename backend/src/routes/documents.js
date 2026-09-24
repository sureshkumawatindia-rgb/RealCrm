const express = require('express');
const multer = require('multer');
const env = require('../config/env');
const crudController = require('../controllers/crudController');
const documentService = require('../services/documentService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const httpError = require('../utils/httpError');
const { idParams } = require('../validators/common');
const schemas = require('../validators/crm');

const router = express.Router();
const controller = crudController(documentService, 'Document');
const can = (modules, action) => requirePermission(modules, action);
const maxMb = Math.round(env.documentMaxBytes / (1024 * 1024));

// One optional file in the "file" field; the other fields arrive as form fields. Plain JSON
// requests (a link document) pass through untouched. utf8 keeps names like "बिल.pdf" intact.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.documentMaxBytes, files: 1, fields: 30 },
  defParamCharset: 'utf8',
});
function acceptFile(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') return next(httpError(413, 'FILE_TOO_LARGE', `Files can be up to ${maxMb} MB. Share a link for bigger files.`));
      return next(httpError(400, 'UPLOAD_ERROR', `Upload failed: ${error.message}`));
    }
    return next(error);
  });
}

router.use(authenticate);
router.get('/', can(documentService.MODULES, 'view'), validate({ query: schemas.documentList }), controller.list);
router.post('/', can('documents', 'create'), acceptFile, validate({ body: schemas.documentCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await documentService.create(req, req.body, req.file), message: 'Document created' });
});
router.get('/:id', can(documentService.MODULES, 'view'), validate({ params: idParams }), controller.get);
router.patch('/:id', can('documents', 'edit'), acceptFile, validate({ params: idParams, body: schemas.documentPatch }), async (req, res) => {
  res.json({ success: true, data: await documentService.update(req, req.valid.params.id, req.body, req.file), message: 'Document updated' });
});
router.delete('/:id', can('documents', 'delete'), validate({ params: idParams }), controller.remove);

// Always a download, never shown inline, so an uploaded HTML or SVG file can't run in the CRM.
router.get('/:id/download', can(documentService.MODULES, 'view'), validate({ params: idParams }), async (req, res) => {
  const { stream, fileName } = await documentService.openFile(req, req.valid.params.id);
  res.attachment(fileName);
  res.type('application/octet-stream');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, no-store');
  stream.on('error', (error) => res.destroy(error));
  stream.pipe(res);
});

module.exports = router;
