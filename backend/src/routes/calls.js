const express = require('express');
const callService = require('../services/callService');
const telephonyService = require('../services/telephonyService');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireRole } = require('../middleware/permissions');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/calls');

// Calls (Phase 6, D85): with the customers module; Settings → Calling for owners and admins.
const callRoutes = express.Router();
callRoutes.use(authenticate);
const can = (action) => requirePermission('customers', action);
callRoutes.get('/', can('view'), validate({ query: schemas.callList }), async (req, res) => {
  res.json({ success: true, data: await callService.list(req, req.valid.query) });
});
callRoutes.post('/', can('edit'), idempotency, validate({ body: schemas.callLog }), async (req, res) => {
  res.status(201).json({ success: true, data: await callService.log(req, req.body), message: 'Call logged' });
});
callRoutes.post('/dial', can('edit'), idempotency, validate({ body: schemas.callDial }), async (req, res) => {
  res.status(201).json({ success: true, data: await callService.dial(req, req.body), message: 'Calling: your phone rings first' });
});
callRoutes.patch('/:id', can('edit'), validate({ params: idParams, body: schemas.callPatch }), async (req, res) => {
  res.json({ success: true, data: await callService.update(req, req.valid.params.id, req.body) });
});

const telephonyRoutes = express.Router();
telephonyRoutes.use(authenticate);
// Whether calling is set up (everyone: the Call button); the details for owners and admins.
telephonyRoutes.get('/', async (req, res) => {
  const data = await telephonyService.get(req);
  const manager = ['owner', 'admin'].includes(req.member?.role);
  res.json({ success: true, data: manager ? data : { connected: data.connected, provider: data.provider || null } });
});
telephonyRoutes.put('/', requireRole('owner', 'admin'), validate({ body: schemas.telephonySave }), async (req, res) => {
  res.json({ success: true, data: await telephonyService.save(req, req.body), message: 'Calling connected' });
});
telephonyRoutes.post('/test', requireRole('owner', 'admin'), async (req, res) => {
  res.json({ success: true, data: await telephonyService.test(req) });
});
telephonyRoutes.delete('/', requireRole('owner', 'admin'), async (req, res) => {
  res.json({ success: true, data: await telephonyService.remove(req), message: 'Calling disconnected' });
});

module.exports = { callRoutes, telephonyRoutes };
