const express = require('express');
const invoiceService = require('../services/invoiceService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/invoices');

// Payment receipts (D101): one per payment on an order, with the order's permissions.
const router = express.Router();
const can = (action) => requirePermission(['leads', 'deals'], action);
const canChat = requirePermission('inbox', 'create');

function sendPdf(res, { buffer, fileName }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
}

router.use(authenticate);
router.get('/:id/pdf', can('view'), validate({ params: idParams }), async (req, res) => {
  sendPdf(res, await invoiceService.receiptPdf(req, req.valid.params.id));
});
router.get('/:id/send-options', can('view'), canChat, validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await invoiceService.sendOptions(req, 'receipt', req.valid.params.id) });
});
router.post('/:id/send', can('edit'), canChat, idempotency, validate({ params: idParams, body: schemas.documentSend }), async (req, res) => {
  res.json({ success: true, data: await invoiceService.send(req, 'receipt', req.valid.params.id, req.body), message: 'Sent on WhatsApp' });
});

module.exports = router;
