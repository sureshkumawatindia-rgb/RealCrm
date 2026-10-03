const express = require('express');
const quotationService = require('../services/quotationService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/quotations');
const orderSchemas = require('../validators/orders');
const { GST_STATES } = require('../constants/gst');

// Quotations, estimates and proforma invoices (Phase 5): the same permissions as leads.
const router = express.Router();
const can = (action) => requirePermission(['leads', 'deals'], action);

router.use(authenticate);
router.get('/', can('view'), validate({ query: schemas.quotationList }), async (req, res) => {
  const { items, pagination } = await quotationService.list(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
// "Quote Sent, no reply for N days" (before /:id).
router.get('/awaiting-reply', can('view'), validate({ query: orderSchemas.awaitingReply }), async (req, res) => {
  res.json({ success: true, data: await quotationService.awaitingReply(req, req.valid.query) });
});
router.post('/', can('create'), idempotency, validate({ body: schemas.quotationCreate }), async (req, res) => {
  const quotation = await quotationService.create(req, req.body);
  res.status(201).json({ success: true, data: quotation, message: `${quotation.type} ${quotation.number} created` });
});
router.get('/:id', can('view'), validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await quotationService.get(req, req.valid.params.id) });
});
router.patch('/:id', can('edit'), validate({ params: idParams, body: schemas.quotationPatch }), async (req, res) => {
  res.json({ success: true, data: await quotationService.update(req, req.valid.params.id, req.body) });
});
router.get('/:id/pdf', can('view'), validate({ params: idParams }), async (req, res) => {
  const { buffer, fileName } = await quotationService.pdf(req, req.valid.params.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
});
// Sending in the WhatsApp chat needs the quotation (leads/deals) and the inbox.
const canChat = requirePermission('inbox', 'create');
router.get('/:id/send-options', can('view'), canChat, validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await quotationService.sendOptions(req, req.valid.params.id) });
});
router.post('/:id/send', can('edit'), canChat, idempotency, validate({ params: idParams, body: schemas.quotationSend }), async (req, res) => {
  const result = await quotationService.sendOnWhatsApp(req, req.valid.params.id, req.body);
  res.json({ success: true, data: result, message: 'Sent on WhatsApp' });
});
router.post('/:id/revise', can('edit'), validate({ params: idParams }), async (req, res) => {
  const quotation = await quotationService.revise(req, req.valid.params.id);
  res.json({ success: true, data: quotation, message: `Revision ${quotation.revision} opened` });
});
router.delete('/:id', can('delete'), validate({ params: idParams }), async (req, res) => {
  await quotationService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Quotation deleted' });
});

// POST /pricing/preview — live totals for the editor (nothing is saved).
const pricingRouter = express.Router();
pricingRouter.use(authenticate);
pricingRouter.post('/preview', can('view'), validate({ body: schemas.pricingPreview }), async (req, res) => {
  res.json({ success: true, data: await quotationService.preview(req, req.body) });
});
// The GST state codes, for the editor's state and place-of-supply lists.
pricingRouter.get('/states', (req, res) => {
  res.json({ success: true, data: GST_STATES.map(({ code, name }) => ({ code, name })) });
});

module.exports = router;
module.exports.pricingRouter = pricingRouter;
