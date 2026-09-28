const automationService = require('../services/automationService');
const { requirePermission } = require('../middleware/permissions');
const idempotency = require('../middleware/idempotency');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/crm');
const { resourceRouter } = require('./workItems');

// Sales Automation settings. Run / enroll accept an Idempotency-Key, so a double click or a
// retried request never creates the tasks twice.
const options = { view: automationService.MODULES, write: ['automation'], remove: ['automation'] };

const workflowRoutes = resourceRouter(automationService.workflows, 'Workflow', {
  ...options, list: schemas.workflowList, create: schemas.workflowCreate, patch: schemas.workflowPatch,
});
workflowRoutes.post('/:id/run', requirePermission('automation', 'edit'), idempotency, validate({ params: idParams }), async (req, res) => {
  const result = await automationService.runWorkflow(req, req.valid.params.id);
  res.json({ success: true, data: result, message: `Workflow ran: ${result.tasks.length} task(s) created` });
});

const sequenceRoutes = resourceRouter(automationService.sequences, 'Sequence', {
  ...options, list: schemas.sequenceList, create: schemas.sequenceCreate, patch: schemas.sequencePatch,
});
sequenceRoutes.post('/:id/enroll', requirePermission('automation', 'edit'), idempotency, validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await automationService.enrollSequence(req, req.valid.params.id), message: 'Enrolled' });
});

module.exports = { workflowRoutes, sequenceRoutes };
