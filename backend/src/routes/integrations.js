const express = require('express');
const apiKeys = require('../services/apiKeyService');
const webhooks = require('../services/outboundWebhookService');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/integrations');
const { API_SCOPES } = require('../constants/api');

// Settings → API & webhooks (Phase 10C, owners and admins): the public API's keys and the
// outbound webhooks with their delivery log.
const byId = validate({ params: idParams });

const apiKeyRoutes = express.Router();
apiKeyRoutes.use(authenticate, requireRole('owner', 'admin'));
apiKeyRoutes.get('/', async (req, res) => {
  res.json({ success: true, data: { items: await apiKeys.list(req), scopes: Object.entries(API_SCOPES).map(([scope, label]) => ({ scope, label })) } });
});
apiKeyRoutes.post('/', validate({ body: schemas.apiKeyCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await apiKeys.create(req, req.body), message: 'API key made. Copy it now: it is not shown again.' });
});
apiKeyRoutes.delete('/:id', byId, async (req, res) => {
  res.json({ success: true, data: await apiKeys.revoke(req, req.valid.params.id), message: 'API key revoked' });
});

const webhookRoutes = express.Router();
webhookRoutes.use(authenticate, requireRole('owner', 'admin'));
webhookRoutes.get('/', async (req, res) => {
  res.json({ success: true, data: { items: await webhooks.list(req), ...webhooks.meta() } });
});
webhookRoutes.post('/', validate({ body: schemas.webhookCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await webhooks.create(req, req.body), message: 'Webhook added. Copy its secret now: it is not shown again.' });
});
webhookRoutes.patch('/:id', validate({ params: idParams, body: schemas.webhookPatch }), async (req, res) => {
  res.json({ success: true, data: await webhooks.update(req, req.valid.params.id, req.body), message: 'Webhook saved' });
});
webhookRoutes.delete('/:id', byId, async (req, res) => {
  await webhooks.remove(req, req.valid.params.id);
  res.json({ success: true, message: 'Webhook removed' });
});
webhookRoutes.post('/:id/test', byId, async (req, res) => {
  res.json({ success: true, data: await webhooks.test(req, req.valid.params.id) });
});
webhookRoutes.post('/:id/rotate-secret', byId, async (req, res) => {
  res.json({ success: true, data: await webhooks.rotateSecret(req, req.valid.params.id), message: 'New secret made. Copy it now.' });
});
webhookRoutes.get('/:id/deliveries', validate({ params: idParams, query: schemas.deliveryList }), async (req, res) => {
  const { items, pagination } = await webhooks.listDeliveries(req, req.valid.params.id, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
webhookRoutes.post('/deliveries/:id/retry', byId, async (req, res) => {
  res.json({ success: true, data: await webhooks.retry(req, req.valid.params.id) });
});

module.exports = { apiKeyRoutes, webhookRoutes };
