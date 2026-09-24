const express = require('express');
const quotationService = require('../services/quotationService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/crm');

const router = express.Router();
const can = (action) => requirePermission(['leads', 'deals'], action);

router.use(authenticate);
router.get('/', can('view'), validate({ query: schemas.quotationList }), async (req, res) => {
  const { items, pagination } = await quotationService.list(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
router.get('/:id', can('view'), validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await quotationService.get(req, req.valid.params.id) });
});
router.patch('/:id', can('edit'), validate({ params: idParams, body: schemas.quotationPatch }), async (req, res) => {
  res.json({ success: true, data: await quotationService.updateStatus(req, req.valid.params.id, req.body) });
});
router.delete('/:id', can('delete'), validate({ params: idParams }), async (req, res) => {
  await quotationService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Quotation deleted' });
});

module.exports = router;
