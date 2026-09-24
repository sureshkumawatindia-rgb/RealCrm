const express = require('express');
const crudController = require('../controllers/crudController');
const leadService = require('../services/leadService');
const quotationService = require('../services/quotationService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/crm');

const router = express.Router();
const controller = crudController(leadService, 'Lead');
const can = (action) => requirePermission(leadService.MODULES, action);
const byId = validate({ params: idParams });

router.use(authenticate);
router.get('/', can('view'), validate({ query: schemas.leadList }), controller.list);
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
router.get('/:id/activities', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await leadService.listActivities(req, req.valid.params.id) });
});
router.post('/:id/activities', can('edit'), validate({ params: idParams, body: schemas.leadNote }), async (req, res) => {
  res.status(201).json({ success: true, data: await leadService.addNote(req, req.valid.params.id, req.body) });
});
router.post('/:id/quotations', can('edit'), validate({ params: idParams, body: schemas.quotationDraft }), async (req, res) => {
  const quotation = await quotationService.saveDraftForLead(req, req.valid.params.id, req.body);
  res.status(quotation.action === 'created' ? 201 : 200).json({ success: true, data: quotation, message: `Quotation ${quotation.action}` });
});

module.exports = router;
