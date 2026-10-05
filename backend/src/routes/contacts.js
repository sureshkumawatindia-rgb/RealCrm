const express = require('express');
const multer = require('multer');
const crudController = require('../controllers/crudController');
const contactService = require('../services/contactService');
const contactImportService = require('../services/contactImportService');
const httpError = require('../utils/httpError');
const noteService = require('../services/noteService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/crm');
const { contactImport } = require('../validators/marketing');

const router = express.Router();
const controller = crudController(contactService, 'Contact');
const can = (action) => requirePermission('customers', action);

router.use(authenticate);

// CSV import (Phase 7): preview the columns, then import with the chosen mapping. One file of up
// to 5 MB in the "file" field.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 } }).single('file');
const importOptions = (body) => {
  let mapping;
  try {
    mapping = JSON.parse(body.mapping || '[]');
  } catch {
    mapping = null;
  }
  const { error, value } = contactImport.validate({
    mapping,
    tags: String(body.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    consent: body.consent || undefined,
    lifecycle: body.lifecycle || undefined,
    updateExisting: body.updateExisting === undefined ? undefined : body.updateExisting === 'true',
    dryRun: body.dryRun === 'true',
  }, { abortEarly: true });
  if (error) throw httpError(400, 'VALIDATION_ERROR', error.message.replace(/"/g, ''));
  return value;
};
router.post('/import/preview', can('create'), upload, async (req, res) => {
  res.json({ success: true, data: contactImportService.preview(req.file) });
});
router.post('/import', can('create'), upload, async (req, res) => {
  const report = await contactImportService.run(req, req.file, importOptions(req.body));
  res.json({ success: true, data: report, message: report.dryRun ? 'Checked: nothing was saved' : `${report.created} added, ${report.updated} updated` });
});

router.get('/', can('view'), validate({ query: schemas.contactList }), controller.list);
router.post('/', can('create'), validate({ body: schemas.contactCreate }), controller.create);
router.get('/:id', can('view'), validate({ params: idParams }), controller.get);
router.patch('/:id', can('edit'), validate({ params: idParams, body: schemas.contactPatch }), controller.update);
router.delete('/:id', can('delete'), validate({ params: idParams }), controller.remove);

// Customer 360 notes. Adding one counts as editing the contact.
router.get('/:id/notes', can('view'), validate({ params: idParams }), async (req, res) => {
  const contact = await contactService.findVisible(req, req.valid.params.id);
  res.json({ success: true, data: await noteService.list(req, 'contact', contact._id) });
});
router.post('/:id/notes', can('edit'), validate({ params: idParams, body: schemas.noteCreate }), async (req, res) => {
  const contact = await contactService.findVisible(req, req.valid.params.id);
  res.status(201).json({ success: true, data: await noteService.add(req, 'contact', contact._id, req.body), message: 'Note added' });
});

module.exports = router;
