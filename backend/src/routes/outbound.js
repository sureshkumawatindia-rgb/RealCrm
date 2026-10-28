const express = require('express');
const dialerService = require('../services/dialerService');
const bulkService = require('../services/bulkService');
const leadService = require('../services/leadService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/outbound');

// The power dialer and bulk actions (Phase 8B, D89). A dialer session is its member's own; the
// calls and changes go through the Customers and Leads permissions of the services they use.
const dialerRoutes = express.Router();
dialerRoutes.use(authenticate);
const customers = (action) => requirePermission('customers', action);
const byItem = validate({ params: schemas.itemParams });

dialerRoutes.get('/sessions', customers('view'), async (req, res) => {
  res.json({ success: true, data: await dialerService.list(req) });
});
dialerRoutes.post('/sessions', customers('edit'), validate({ body: schemas.sessionCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await dialerService.create(req, req.body) });
});
dialerRoutes.get('/sessions/:id', customers('view'), validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await dialerService.get(req, req.valid.params.id) });
});
dialerRoutes.post('/sessions/:id/items/:n/call', customers('edit'), byItem, async (req, res) => {
  res.json({ success: true, data: await dialerService.call(req, req.valid.params.id, req.valid.params.n) });
});
dialerRoutes.post('/sessions/:id/items/:n/result', customers('edit'), validate({ params: schemas.itemParams, body: schemas.itemResult }), async (req, res) => {
  res.json({ success: true, data: await dialerService.result(req, req.valid.params.id, req.valid.params.n, req.body) });
});
dialerRoutes.post('/sessions/:id/items/:n/skip', customers('edit'), validate({ params: schemas.itemParams, body: schemas.itemSkip }), async (req, res) => {
  res.json({ success: true, data: await dialerService.skip(req, req.valid.params.id, req.valid.params.n, req.body) });
});
dialerRoutes.post('/sessions/:id/finish', customers('edit'), validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await dialerService.finish(req, req.valid.params.id) });
});

// Bulk actions on leads and customers (D89, D100): each row checked on its own; an
// Idempotency-Key replays the answer. More than 200 rows: 202 with the job to follow.
const bulkRoutes = express.Router();
bulkRoutes.use(authenticate);
const bulkAnswer = (res, data) => res.status(data.jobId ? 202 : 200).json({ success: true, data });
bulkRoutes.post('/leads', requirePermission(leadService.MODULES, 'edit'), idempotency, validate({ body: schemas.bulkLeads }), async (req, res) => {
  bulkAnswer(res, await bulkService.start(req, 'lead', req.body, req.get('Idempotency-Key')));
});
bulkRoutes.post('/contacts', requirePermission('customers', 'edit'), idempotency, validate({ body: schemas.bulkContacts }), async (req, res) => {
  bulkAnswer(res, await bulkService.start(req, 'contact', req.body, req.get('Idempotency-Key')));
});
bulkRoutes.get('/jobs/:id', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await bulkService.getJob(req, req.valid.params.id) });
});

module.exports = { dialerRoutes, bulkRoutes };
