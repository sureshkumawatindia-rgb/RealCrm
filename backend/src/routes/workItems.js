const express = require('express');
const crudController = require('../controllers/crudController');
const taskService = require('../services/taskService');
const eventService = require('../services/eventService');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/crm');

// The standard list / create / get / patch / delete routes for a resource service
// (tasks, events, tickets, campaigns, workflows, sequences).
function resourceRouter(service, label, { view, write, remove, list, create, patch }) {
  const router = express.Router();
  const controller = crudController(service, label);
  router.use(authenticate);
  router.get('/', requirePermission(view, 'view'), validate({ query: list }), controller.list);
  router.post('/', requirePermission(write, 'create'), validate({ body: create }), controller.create);
  router.get('/:id', requirePermission(view, 'view'), validate({ params: idParams }), controller.get);
  router.patch('/:id', requirePermission(write, 'edit'), validate({ params: idParams, body: patch }), controller.update);
  router.delete('/:id', requirePermission(remove, 'delete'), validate({ params: idParams }), controller.remove);
  return router;
}

// Tasks: read by every page that shows them; created from Tasks and the Deals follow-up panel.
// Automation tasks are created on the server by workflow and sequence steps (Phase 6).
const taskRoutes = resourceRouter(taskService, 'Task', {
  view: taskService.MODULES,
  write: ['tasks', 'deals'],
  remove: ['tasks', 'deals'],
  list: schemas.taskList,
  create: schemas.taskCreate,
  patch: schemas.taskPatch,
});

// Events: read by Calendar, the dashboard, Customer 360 and reports.
const eventRoutes = resourceRouter(eventService, 'Event', {
  view: eventService.MODULES,
  write: ['calendar'],
  remove: ['calendar'],
  list: schemas.eventList,
  create: schemas.eventCreate,
  patch: schemas.eventPatch,
});

module.exports = { taskRoutes, eventRoutes, resourceRouter };
