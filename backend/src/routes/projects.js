const express = require('express');
const projectService = require('../services/projectService');
const { authenticate } = require('../middleware/auth');
const { requirePermission, requireRole } = require('../middleware/permissions');
const validate = require('../middleware/validate');
const { idParams } = require('../validators/common');
const schemas = require('../validators/projects');

// Projects after the sale (Phase 10, D92): their own module, apart from sales. Templates and the
// "on Won" switch are the owners' and admins'.
const can = (action) => requirePermission('projects', action);
const managers = requireRole('owner', 'admin');
const byId = validate({ params: idParams });

const projectRoutes = express.Router();
projectRoutes.use(authenticate);
projectRoutes.get('/', can('view'), validate({ query: schemas.projectList }), async (req, res) => {
  const { items, pagination } = await projectService.list(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
});
// Before /:id.
projectRoutes.get('/summary', validate({ query: schemas.summary }), async (req, res) => {
  res.json({ success: true, data: await projectService.summary(req, req.valid.query) });
});
projectRoutes.get('/settings', can('view'), async (req, res) => {
  res.json({ success: true, data: await projectService.getSettings(req) });
});
projectRoutes.put('/settings', managers, validate({ body: schemas.settings }), async (req, res) => {
  res.json({ success: true, data: await projectService.saveSettings(req, req.body) });
});
projectRoutes.post('/', can('create'), validate({ body: schemas.projectCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await projectService.create(req, req.body), message: 'Project created' });
});
projectRoutes.get('/:id', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await projectService.get(req, req.valid.params.id) });
});
projectRoutes.patch('/:id', can('edit'), validate({ params: idParams, body: schemas.projectPatch }), async (req, res) => {
  res.json({ success: true, data: await projectService.update(req, req.valid.params.id, req.body), message: 'Project updated' });
});
projectRoutes.delete('/:id', can('delete'), byId, async (req, res) => {
  await projectService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Project deleted' });
});
projectRoutes.post('/:id/milestones', can('edit'), validate({ params: idParams, body: schemas.milestoneCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await projectService.addMilestone(req, req.valid.params.id, req.body) });
});
projectRoutes.patch('/:id/milestones/:milestoneId', can('edit'), validate({ params: schemas.milestoneParams, body: schemas.milestonePatch }), async (req, res) => {
  res.json({ success: true, data: await projectService.updateMilestone(req, req.valid.params.id, req.valid.params.milestoneId, req.body) });
});
projectRoutes.delete('/:id/milestones/:milestoneId', can('edit'), validate({ params: schemas.milestoneParams }), async (req, res) => {
  res.json({ success: true, data: await projectService.removeMilestone(req, req.valid.params.id, req.valid.params.milestoneId) });
});
projectRoutes.get('/:id/tasks', can('view'), byId, async (req, res) => {
  res.json({ success: true, data: await projectService.listTasks(req, req.valid.params.id) });
});
projectRoutes.post('/:id/tasks', can('edit'), validate({ params: idParams, body: schemas.taskCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await projectService.addTask(req, req.valid.params.id, req.body) });
});
projectRoutes.patch('/:id/tasks/:taskId', can('edit'), validate({ params: schemas.taskParams, body: schemas.taskPatch }), async (req, res) => {
  res.json({ success: true, data: await projectService.updateTask(req, req.valid.params.id, req.valid.params.taskId, req.body) });
});

const templateRoutes = express.Router();
templateRoutes.use(authenticate);
templateRoutes.get('/', can('view'), async (req, res) => {
  res.json({ success: true, data: await projectService.listTemplates(req) });
});
templateRoutes.post('/', managers, validate({ body: schemas.templateCreate }), async (req, res) => {
  res.status(201).json({ success: true, data: await projectService.createTemplate(req, req.body), message: 'Template saved' });
});
templateRoutes.patch('/:id', managers, validate({ params: idParams, body: schemas.templatePatch }), async (req, res) => {
  res.json({ success: true, data: await projectService.updateTemplate(req, req.valid.params.id, req.body), message: 'Template saved' });
});
templateRoutes.delete('/:id', managers, byId, async (req, res) => {
  await projectService.removeTemplate(req, req.valid.params.id);
  res.json({ success: true, data: { deleted: true }, message: 'Template deleted' });
});

module.exports = { projectRoutes, templateRoutes };
