const express = require('express');
const gateways = require('../services/paymentGatewayService');
const links = require('../services/paymentLinkService');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/permissions');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/payments');

// Payments (Phase 8). /payments: the gateways and link settings (owners and admins, like
// Settings → WhatsApp). /payment-links: links for orders, quotations and customers, with the
// same permissions as orders.
const settingsRoutes = express.Router();
settingsRoutes.use(authenticate, requireRole('owner', 'admin'));
const byId = validate({ params: idParams });

settingsRoutes.get('/connections', async (req, res) => {
  res.json({ success: true, data: await gateways.list(req) });
});
settingsRoutes.post('/connections', validate({ body: schemas.connectionCreate }), async (req, res) => {
  const connection = await gateways.create(req, req.body);
  res.status(201).json({ success: true, data: connection, message: `${connection.providerName} connected` });
});
settingsRoutes.patch('/connections/:id', validate({ params: idParams, body: schemas.connectionPatch }), async (req, res) => {
  res.json({ success: true, data: await gateways.update(req, req.valid.params.id, req.body), message: 'Payment gateway saved' });
});
settingsRoutes.post('/connections/:id/test', byId, async (req, res) => {
  res.json({ success: true, data: await gateways.test(req, req.valid.params.id) });
});
settingsRoutes.delete('/connections/:id', byId, async (req, res) => {
  await gateways.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Payment gateway removed' });
});
settingsRoutes.get('/settings', async (req, res) => {
  res.json({ success: true, data: await gateways.getSettings(req) });
});
settingsRoutes.put('/settings', validate({ body: schemas.settings }), async (req, res) => {
  res.json({ success: true, data: await gateways.putSettings(req, req.body), message: 'Payment settings saved' });
});

const linkRoutes = express.Router();
const can = (action) => requirePermission(['leads', 'deals'], action);
linkRoutes.use(authenticate);
linkRoutes.get('/', can('view'), validate({ query: schemas.linkList }), async (req, res) => {
  const { items, pagination } = await links.list(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
linkRoutes.post('/', can('edit'), idempotency, validate({ body: schemas.linkCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await links.create(req, req.body), message: 'Payment link created' });
});
linkRoutes.get('/:id', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await links.get(req, req.valid.params.id) });
});
linkRoutes.post('/:id/refresh', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await links.refresh(req, req.valid.params.id) });
});
linkRoutes.post('/:id/cancel', can('edit'), byId, async (req, res) => {
  res.json({ success: true, data: await links.cancel(req, req.valid.params.id), message: 'Payment link cancelled' });
});

module.exports = { settingsRoutes, linkRoutes };
