const express = require('express');
const orderService = require('../services/orderService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/orders');
const paymentSchemas = require('../validators/payments');

// Orders (Phase 5): the same permissions as leads and quotations; WhatsApp updates need the inbox.
const router = express.Router();
const can = (action) => requirePermission(['leads', 'deals'], action);
const canChat = requirePermission('inbox', 'create');

router.use(authenticate);
router.get('/', can('view'), validate({ query: schemas.orderList }), async (req, res) => {
  const { items, pagination } = await orderService.list(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
router.get('/summary', can('view'), async (req, res) => {
  res.json({ success: true, data: await orderService.summary(req) });
});
// Money still to come (Phase 8): unpaid and part-paid orders, oldest first, with totals by age.
router.get('/dues', can('view'), validate({ query: paymentSchemas.dues }), async (req, res) => {
  res.json({ success: true, data: await orderService.dues(req, req.valid.query) });
});
router.post('/', can('create'), idempotency, validate({ body: schemas.orderCreate }), async (req, res) => {
  const order = await orderService.create(req, req.body);
  res.status(201).json({ success: true, data: order, message: `Order ${order.number} created` });
});
router.get('/:id', can('view'), validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await orderService.get(req, req.valid.params.id) });
});
router.patch('/:id', can('edit'), validate({ params: idParams, body: schemas.orderPatch }), async (req, res) => {
  res.json({ success: true, data: await orderService.update(req, req.valid.params.id, req.body) });
});
router.post('/:id/stage', can('edit'), validate({ params: idParams, body: schemas.orderStage }), async (req, res) => {
  const order = await orderService.changeStage(req, req.valid.params.id, req.body);
  res.json({ success: true, data: order, message: `Order moved to ${order.stage}` });
});
// Payments received outside the CRM's payment links (cash, bank transfer, cheque …).
router.post('/:id/payments', can('edit'), idempotency, validate({ params: idParams, body: paymentSchemas.manualPayment }), async (req, res) => {
  res.status(201).json({ success: true, data: await orderService.addManualPayment(req, req.valid.params.id, req.body), message: 'Payment recorded' });
});
router.delete('/:id/payments/:paymentId', can('edit'), validate({ params: paymentSchemas.paymentParams }), async (req, res) => {
  res.json({ success: true, data: await orderService.removeManualPayment(req, req.valid.params.id, req.valid.params.paymentId), message: 'Payment removed' });
});
router.get('/:id/notify-options', can('view'), canChat, validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await orderService.notifyOptions(req, req.valid.params.id) });
});
router.post('/:id/notify', can('edit'), canChat, idempotency, validate({ params: idParams, body: schemas.orderNotify }), async (req, res) => {
  res.json({ success: true, data: await orderService.notify(req, req.valid.params.id, req.body), message: 'Update sent on WhatsApp' });
});

module.exports = router;
