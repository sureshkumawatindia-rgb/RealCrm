const express = require('express');
const automationService = require('../services/automationService');
const workflowService = require('../services/workflowService');
const notificationService = require('../services/notificationService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/crm');
const automationSchemas = require('../validators/automation');
const { resourceRouter } = require('./workItems');

// Sales Automation. Workflows run on the automation engine (Phase 6); a test run accepts an
// Idempotency-Key, so a double click never starts it twice. Sequences stay as in Phase 2 until
// Phase 6B. The bell (notifications) belongs to every member.
const can = (action) => requirePermission('automation', action);
const byId = validate({ params: idParams });

const workflowRoutes = express.Router();
workflowRoutes.use(authenticate);
workflowRoutes.get('/', can('view'), validate({ query: automationSchemas.workflowList }), async (req, res) => {
  const { items, pagination } = await workflowService.list(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
// What the workflow builder offers (before /:id).
workflowRoutes.get('/meta', can('view'), (req, res) => {
  res.json({ success: true, data: workflowService.meta() });
});
workflowRoutes.post('/', can('create'), validate({ body: automationSchemas.workflowCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await workflowService.create(req, req.body), message: 'Workflow created' });
});
workflowRoutes.get('/:id', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await workflowService.get(req, req.valid.params.id) });
});
workflowRoutes.patch('/:id', can('edit'), validate({ params: idParams, body: automationSchemas.workflowPatch }), async (req, res) => {
  res.json({ success: true, data: await workflowService.update(req, req.valid.params.id, req.body), message: 'Workflow updated' });
});
workflowRoutes.delete('/:id', can('delete'), byId, async (req, res) => {
  await workflowService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Workflow deleted' });
});
workflowRoutes.post('/:id/run', can('edit'), idempotency, validate({ params: idParams, body: automationSchemas.workflowRun }), async (req, res) => {
  const run = await workflowService.runByHand(req, req.valid.params.id, req.body);
  res.status(202).json({ success: true, data: run, message: 'Test run started' });
});
workflowRoutes.get('/:id/runs', can('view'), validate({ params: idParams, query: automationSchemas.runList }), async (req, res) => {
  await workflowService.findVisible(req, req.valid.params.id);
  const { items, pagination } = await workflowService.listRuns(req, { ...req.valid.query, workflowId: req.valid.params.id });
  res.json({ success: true, data: items, pagination });
});

// The run log of every workflow.
const runRoutes = express.Router();
runRoutes.use(authenticate);
runRoutes.get('/', can('view'), validate({ query: automationSchemas.runList }), async (req, res) => {
  const { items, pagination } = await workflowService.listRuns(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
runRoutes.get('/:id', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await workflowService.getRun(req, req.valid.params.id) });
});
runRoutes.post('/:id/cancel', can('edit'), byId, async (req, res) => {
  res.json({ success: true, data: await workflowService.cancelRun(req, req.valid.params.id), message: 'Run stopped' });
});

const sequenceRoutes = resourceRouter(automationService.sequences, 'Sequence', {
  view: automationService.MODULES, write: ['automation'], remove: ['automation'],
  list: schemas.sequenceList, create: schemas.sequenceCreate, patch: schemas.sequencePatch,
});
sequenceRoutes.post('/:id/enroll', can('edit'), idempotency, byId, async (req, res) => {
  res.json({ success: true, data: await automationService.enrollSequence(req, req.valid.params.id), message: 'Enrolled' });
});

// The bell (D31): each member's own notifications; no module permission needed.
const notificationRoutes = express.Router();
notificationRoutes.use(authenticate);
notificationRoutes.get('/', validate({ query: automationSchemas.notificationList }), async (req, res) => {
  res.json({ success: true, data: await notificationService.list(req, req.valid.query) });
});
notificationRoutes.post('/read-all', async (req, res) => {
  res.json({ success: true, data: await notificationService.markAllRead(req) });
});
notificationRoutes.post('/:id/read', byId, async (req, res) => {
  res.json({ success: true, data: await notificationService.markRead(req, req.valid.params.id) });
});

module.exports = { workflowRoutes, runRoutes, sequenceRoutes, notificationRoutes };
