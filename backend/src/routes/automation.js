const express = require('express');
const workflowService = require('../services/workflowService');
const sequenceService = require('../services/sequenceService');
const notificationService = require('../services/notificationService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const automationSchemas = require('../validators/automation');

// Sales Automation. Workflows run on the automation engine (Phase 6); sequences send follow-ups
// per customer (Phase 6B). A test run and enrolling accept an Idempotency-Key, so a double click
// never does it twice. The bell (notifications) belongs to every member.
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

const sequenceRoutes = express.Router();
sequenceRoutes.use(authenticate);
sequenceRoutes.get('/', can('view'), validate({ query: automationSchemas.sequenceList }), async (req, res) => {
  const { items, pagination } = await sequenceService.list(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
sequenceRoutes.post('/', can('create'), validate({ body: automationSchemas.sequenceCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await sequenceService.create(req, req.body), message: 'Sequence created' });
});
sequenceRoutes.get('/:id', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await sequenceService.get(req, req.valid.params.id) });
});
sequenceRoutes.patch('/:id', can('edit'), validate({ params: idParams, body: automationSchemas.sequencePatch }), async (req, res) => {
  res.json({ success: true, data: await sequenceService.update(req, req.valid.params.id, req.body), message: 'Sequence updated' });
});
sequenceRoutes.delete('/:id', can('delete'), byId, async (req, res) => {
  await sequenceService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Sequence deleted' });
});
sequenceRoutes.post('/:id/enroll', can('edit'), idempotency, validate({ params: idParams, body: automationSchemas.sequenceEnroll }), async (req, res) => {
  const enrollment = await sequenceService.enroll(req, req.valid.params.id, req.body);
  res.status(201).json({ success: true, data: enrollment, message: `${enrollment.label || 'The customer'} was added to the sequence` });
});
sequenceRoutes.get('/:id/enrollments', can('view'), validate({ params: idParams, query: automationSchemas.enrollmentList }), async (req, res) => {
  await sequenceService.findVisible(req, req.valid.params.id);
  const { items, pagination } = await sequenceService.listEnrollments(req, { ...req.valid.query, sequenceId: req.valid.params.id });
  res.json({ success: true, data: items, pagination });
});

// Who is (or was) in a sequence.
const enrollmentRoutes = express.Router();
enrollmentRoutes.use(authenticate);
enrollmentRoutes.get('/', can('view'), validate({ query: automationSchemas.enrollmentList }), async (req, res) => {
  const { items, pagination } = await sequenceService.listEnrollments(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
enrollmentRoutes.get('/:id', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await sequenceService.getEnrollment(req, req.valid.params.id) });
});
enrollmentRoutes.post('/:id/stop', can('edit'), byId, async (req, res) => {
  res.json({ success: true, data: await sequenceService.stopEnrollment(req, req.valid.params.id), message: 'Stopped' });
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

module.exports = { workflowRoutes, runRoutes, sequenceRoutes, enrollmentRoutes, notificationRoutes };
