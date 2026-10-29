const express = require('express');
const invoiceService = require('../services/invoiceService');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireRole } = require('../middleware/permissions');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/invoices');

// Tax invoices and credit notes (D101): made from an order (routes/orders.js), with the order's
// permissions (leads and deals); sending in the WhatsApp chat needs the inbox too. A credit note
// (it takes money and GST back) is for an owner or admin.
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
  sendPdf(res, await invoiceService.pdf(req, req.valid.params.id));
});
router.post('/:id/credit-notes', requireRole('owner', 'admin'), idempotency, validate({ params: idParams, body: schemas.creditNote }), async (req, res) => {
  const result = await invoiceService.creditNote(req, req.valid.params.id, req.body);
  res.status(201).json({ success: true, data: result, message: `Credit note ${result.creditNote.number} made` });
});
router.get('/:id/send-options', can('view'), canChat, validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await invoiceService.sendOptions(req, 'invoice', req.valid.params.id) });
});
router.post('/:id/send', can('edit'), canChat, idempotency, validate({ params: idParams, body: schemas.documentSend }), async (req, res) => {
  res.json({ success: true, data: await invoiceService.send(req, 'invoice', req.valid.params.id, req.body), message: 'Sent on WhatsApp' });
});

module.exports = router;
