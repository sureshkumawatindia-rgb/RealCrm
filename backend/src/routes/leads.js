const express = require('express');
const multer = require('multer');
const crudController = require('../controllers/crudController');
const leadService = require('../services/leadService');
const leadImportService = require('../services/leadImportService');
const httpError = require('../utils/httpError');
const projectService = require('../services/projectService');
const projectSchemas = require('../validators/projects');
const quotationService = require('../services/quotationService');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireRole } = require('../middleware/permissions');
const tableExport = require('../services/tableExportService');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/crm');
const reportSchemas = require('../validators/reports');

const router = express.Router();
const controller = crudController(leadService, 'Lead');
const can = (action) => requirePermission(leadService.MODULES, action);
const byId = validate({ params: idParams });

router.use(authenticate);
router.get('/', can('view'), validate({ query: schemas.leadList }), controller.list);
// Phase 3 (D115): the numbers the pages show (by stage, product and owner; won this month), and the
// ids the list's search and filters match, for "select all" — without loading every lead.
router.get('/summary', can('view'), validate({ query: reportSchemas.range }), async (req, res) => {
  res.json({ success: true, data: await leadService.summary(req, req.valid.query) });
});
router.get('/ids', can('view'), validate({ query: schemas.leadList }), async (req, res) => {
  res.json({ success: true, data: await leadService.matchingIds(req, req.valid.query) });
});
// G1 (D105): leads from a CSV or Excel file — preview the columns, then import with the chosen
// mapping (dryRun = check first). One file of up to 5 MB in the "file" field.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 } }).single('file');
const importOptions = (body) => {
  let mapping;
  try {
    mapping = JSON.parse(body.mapping || '[]');
  } catch {
    mapping = null;
  }
  const { error, value } = schemas.leadImport.validate({
    mapping,
    pipelineId: body.pipelineId || undefined,
    ownerFallback: body.ownerFallback || undefined,
    openLeads: body.openLeads || undefined,
    tags: String(body.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    runAutomations: body.runAutomations === 'true',
    dryRun: body.dryRun === 'true',
  }, { abortEarly: true });
  if (error) throw httpError(400, 'VALIDATION_ERROR', error.message.replace(/"/g, ''));
  return value;
};
router.post('/import/preview', can('create'), upload, async (req, res) => {
  res.json({ success: true, data: await leadImportService.preview(req, req.file) });
});
router.post('/import', can('create'), upload, async (req, res) => {
  const report = await leadImportService.run(req, req.file, importOptions(req.body));
  res.json({ success: true, data: report, message: report.dryRun ? 'Checked: nothing was saved' : `${report.created} leads added` });
});
// Download Excel (D82): the list as on screen, for owners and admins (audited).
router.get('/export', requireRole('owner', 'admin'), validate({ query: schemas.leadExport }), async (req, res) => {
  const { fileName, type, body } = await tableExport.exportList(req, 'leads', req.valid.query);
  res.attachment(fileName);
  res.type(type);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(body);
});
// The leads ticked in the list (D100).
router.post('/export', requireRole('owner', 'admin'), validate({ body: schemas.selectedExport }), async (req, res) => {
  const { fileName, type, body } = await tableExport.exportSelected(req, 'leads', req.body);
  res.attachment(fileName);
  res.type(type);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(body);
});
router.post('/', can('create'), idempotency, validate({ body: schemas.leadCreate }), controller.create);
router.get('/:id', can('view'), byId, controller.get);
router.patch('/:id', can('edit'), validate({ params: idParams, body: schemas.leadPatch }), controller.update);
router.delete('/:id', can('delete'), byId, controller.remove);

router.post('/:id/stage', can('edit'), validate({ params: idParams, body: schemas.leadStage }), async (req, res) => {
  res.json({ success: true, data: await leadService.changeStage(req, req.valid.params.id, req.body), message: 'Stage changed' });
});
router.post('/:id/convert', can('edit'), idempotency, byId, async (req, res) => {
  res.json({ success: true, data: await leadService.convert(req, req.valid.params.id), message: 'Converted to customer' });
});
// Every stage move, oldest first, with the time in each stage (D84).
router.get('/:id/stage-history', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await leadService.stageHistory(req, req.valid.params.id) });
});
router.get('/:id/activities', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await leadService.listActivities(req, req.valid.params.id) });
});
// Who can be @mentioned on this deal (D87): teammates who can open it.
// "Start the project" on a won deal (D92): idempotent; Projects create, and the deal visible.
router.post('/:id/project', requirePermission('projects', 'create'), validate({ params: idParams, body: projectSchemas.startFromLead }), async (req, res) => {
  const { project, created } = await projectService.startFromLead(req, req.valid.params.id, req.body);
  res.status(created ? 201 : 200).json({ success: true, data: project, created });
});
router.get('/:id/mentionable', can('view'), validate({ params: idParams, query: schemas.mentionQuery }), async (req, res) => {
  res.json({ success: true, data: await leadService.mentionable(req, req.valid.params.id, req.valid.query) });
});
router.post('/:id/activities', can('edit'), validate({ params: idParams, body: schemas.leadNote }), async (req, res) => {
  res.status(201).json({ success: true, data: await leadService.addNote(req, req.valid.params.id, req.body) });
});
router.post('/:id/quotations', can('edit'), validate({ params: idParams, body: schemas.quotationDraft }), async (req, res) => {
  const quotation = await quotationService.saveDraftForLead(req, req.valid.params.id, req.body);
  res.status(quotation.action === 'created' ? 201 : 200).json({ success: true, data: quotation, message: `Quotation ${quotation.action}` });
});

module.exports = router;
