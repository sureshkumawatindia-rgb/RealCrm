const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Project = require('../models/Project');
const ProjectTemplate = require('../models/ProjectTemplate');
const Task = require('../models/Task');
const bus = require('../realtime/bus');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { indiaDate } = require('../utils/dates');
const { nextSequence } = require('../utils/counter');
const { searchFilter } = require('../utils/listQuery');
const { toPage, paginationMeta } = require('../utils/pagination');
const { can, canViewAll, isManager } = require('../constants/permissions');
const { OPEN_PROJECT_STATUSES } = require('../constants/projects');
const leadService = require('./leadService');
const contactService = require('./contactService');
const { serializeTask } = require('./taskService');

// Projects after the sale (Phase 10, D92). A project may start from a won deal — by a click, or
// by itself when the company switched that on — and then at most once per deal: the unique
// (company, deal) key makes a second start, a double click or a race with the automatic job
// find the same project. It is made with its template's milestones and tasks in one transaction.
// Projects have their own module: a member sees the projects they manage or work on (or all
// with projects:view_all); sales access gives nothing here, and the other way round.
const JOB = 'projects.won';
const DAY = 24 * 60 * 60 * 1000;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const invalid = (field, message, code = 'INVALID') => httpError(400, 'VALIDATION_ERROR', message, [{ field, code, message }]);

function scope(req) {
  const base = { organizationId: req.tenant.organizationId };
  if (canViewAll(req.member, 'projects')) return base;
  const me = req.member._id;
  return { ...base, $or: [{ managerId: me }, { memberIds: me }, { createdByMemberId: me }] };
}

// Done and all tasks per project.
async function taskCounts(organizationId, ids) {
  if (!ids.length) return new Map();
  const rows = await Task.aggregate([
    { $match: { organizationId: new mongoose.Types.ObjectId(String(organizationId)), relatedType: 'Project', relatedId: { $in: ids.map((id) => new mongoose.Types.ObjectId(String(id))) }, deletedAt: null } },
    { $group: { _id: '$relatedId', total: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ['$status', 'Done'] }, 1, 0] } } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { total: r.total, done: r.done }]));
}

// Done tasks of all tasks; with no tasks, done milestones of all milestones.
function progressOf(project, counts = { total: 0, done: 0 }) {
  if (project.status === 'completed') return 100;
  if (counts.total) return Math.round((counts.done / counts.total) * 100);
  const milestones = project.milestones || [];
  return milestones.length ? Math.round((milestones.filter((m) => m.done).length / milestones.length) * 100) : 0;
}

function serialize(project, counts) {
  const today = indiaDate(0);
  return {
    id: project._id,
    number: project.number,
    name: project.name,
    status: project.status,
    leadId: project.leadId || null,
    contactId: project.contactId || null,
    managerId: project.managerId || null,
    memberIds: project.memberIds || [],
    startDate: project.startDate,
    dueDate: project.dueDate,
    description: project.description,
    valuePaise: project.valuePaise,
    templateId: project.templateId || null,
    milestones: (project.milestones || []).map((m) => ({ id: m._id, name: m.name, dueDate: m.dueDate, done: m.done, doneAt: m.doneAt || null })),
    progress: progressOf(project, counts),
    tasks: counts || { total: 0, done: 0 },
    overdue: Boolean(project.dueDate && project.dueDate < today && OPEN_PROJECT_STATUSES.includes(project.status)),
    completedAt: project.completedAt || null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

async function findVisible(req, id) {
  const project = mongoose.isValidObjectId(id) ? await Project.findOne({ _id: id, ...scope(req) }) : null;
  if (!project) throw httpError(404, 'NOT_FOUND', 'Project not found');
  return project;
}
const editable = async (req, id) => {
  const project = await findVisible(req, id);
  // Its manager, or an owner or admin, changes the project itself; the team works on tasks.
  if (!isManager(req.member) && String(project.managerId) !== String(req.member._id) && String(project.createdByMemberId) !== String(req.member._id)) {
    throw httpError(403, 'FORBIDDEN', 'Only the project manager (or an owner or admin) can change this project.');
  }
  return project;
};

async function activeMembers(organizationId, ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const found = await OrganizationMember.find({ _id: { $in: unique }, organizationId, status: 'active' }).select('_id');
  if (found.length !== unique.length) throw invalid('memberIds', 'Pick active members of your team.', 'INVALID_MEMBER');
  return unique;
}

// Makes the project (and its template's tasks) inside a transaction. actor: who it is "by".
async function build({ organizationId, actor, fields, template, session }) {
  const start = fields.startDate || indiaDate(0);
  const milestones = (template?.milestones || []).map((m) => ({ _id: new mongoose.Types.ObjectId(), name: m.name, dueDate: addDays(start, m.dueAfterDays || 0), done: false }));
  const n = await nextSequence(organizationId, 'project', { session });
  const [project] = await Project.create([{
    organizationId,
    number: `PR-${String(n).padStart(4, '0')}`,
    name: fields.name,
    status: 'not_started',
    leadId: fields.leadId,
    contactId: fields.contactId,
    managerId: fields.managerId,
    memberIds: fields.memberIds || [],
    startDate: start,
    dueDate: fields.dueDate || (template?.days ? addDays(start, template.days) : ''),
    description: fields.description || '',
    valuePaise: fields.valuePaise || 0,
    templateId: template?._id,
    milestones,
    createdById: actor.userId,
    createdByMemberId: actor.memberId,
  }], { session });
  if (template?.tasks?.length) {
    await Task.insertMany(template.tasks.map((task) => ({
      organizationId,
      title: task.title,
      priority: task.priority,
      dueDate: addDays(start, task.dueAfterDays || 0),
      assigneeId: task.forManager ? fields.managerId : undefined,
      status: 'To Do',
      origin: 'project',
      relatedType: 'Project',
      relatedId: project._id,
      relatedName: project.name,
      milestoneId: Number.isInteger(task.milestone) ? milestones[task.milestone]?._id : undefined,
      createdById: actor.userId,
      createdByMemberId: actor.memberId,
    })), { session });
  }
  return project;
}

const templateFor = async (organizationId, templateId) => {
  if (!templateId) return null;
  const template = await ProjectTemplate.findOne({ _id: templateId, organizationId });
  if (!template) throw invalid('templateId', 'Pick one of your project templates.', 'INVALID_TEMPLATE');
  return template;
};
const actorOf = (req) => ({ userId: req.user._id, memberId: req.member._id });

// POST /projects — a project by hand (from a deal or customer, or neither).
async function create(req, body) {
  const organizationId = req.tenant.organizationId;
  const template = await templateFor(organizationId, body.templateId);
  const lead = body.leadId ? await leadService.findVisible(req, body.leadId) : null;
  const contact = body.contactId ? await contactService.findVisible(req, body.contactId) : null;
  const managerId = body.managerId || req.member._id;
  const memberIds = await activeMembers(organizationId, [managerId, ...(body.memberIds || [])]);
  if (lead && await Project.exists({ organizationId, leadId: lead._id })) throw httpError(409, 'PROJECT_EXISTS', 'This deal has a project already.');
  let project;
  await mongoose.connection.transaction(async (session) => {
    project = await build({
      organizationId, actor: actorOf(req), template, session,
      fields: { ...body, managerId, memberIds, leadId: lead?._id, contactId: contact?._id || lead?.contactId, valuePaise: body.valuePaise ?? lead?.expectedValuePaise ?? 0 },
    });
  });
  await audit(req, { action: 'project.created', entityType: 'Project', entityId: project._id, changes: { name: project.name, leadId: project.leadId, templateId: project.templateId } });
  return serialize(project, (await taskCounts(organizationId, [project._id])).get(String(project._id)));
}

// The deal's project: started now, or the one it has. → { project, created }
async function startForLead({ organizationId, lead, actor, templateId, name, startDate, managerId, req }) {
  const existing = await Project.findOne({ organizationId, leadId: lead._id });
  if (existing) return { project: existing, created: false };
  let template = null;
  try {
    template = await templateFor(organizationId, templateId);
  } catch (error) {
    if (req) throw error;
    logger.warn(`Project template ${templateId} is gone; the project for lead ${lead._id} starts without it`);
  }
  const manager = managerId || lead.ownerId || actor.memberId;
  const memberIds = [...new Set([manager, lead.ownerId].filter(Boolean).map(String))];
  const contact = lead.contactId ? await Contact.findOne({ _id: lead.contactId, organizationId }).select('name') : null;
  try {
    let project;
    await mongoose.connection.transaction(async (session) => {
      project = await build({
        organizationId, actor, template, session,
        fields: { name: name || [lead.title, contact?.name].filter(Boolean).join(' — ').slice(0, 120) || 'Project', leadId: lead._id, contactId: lead.contactId, managerId: manager, memberIds, startDate, valuePaise: lead.expectedValuePaise || 0 },
      });
    });
    return { project, created: true };
  } catch (error) {
    if (error.code !== 11000) throw error;
    // The button and the automatic job at the same moment: the other one made it.
    return { project: await Project.findOne({ organizationId, leadId: lead._id }), created: false };
  }
}

// POST /leads/:id/project — "Start the project" on a won deal (idempotent).
async function startFromLead(req, leadId, body) {
  const lead = await leadService.findVisible(req, leadId);
  if (lead.stage !== 'Won') throw httpError(409, 'DEAL_NOT_WON', 'Win the deal first: a project starts from a won deal.');
  const organizationId = req.tenant.organizationId;
  if (body.managerId) await activeMembers(organizationId, [body.managerId]);
  const { project, created } = await startForLead({ organizationId, lead, actor: actorOf(req), ...body, req });
  if (created) await audit(req, { action: 'project.started_from_deal', entityType: 'Project', entityId: project._id, changes: { leadId: String(lead._id) } });
  return { project: serialize(project, (await taskCounts(organizationId, [project._id])).get(String(project._id))), created };
}

async function list(req, query) {
  const and = [
    ...(query.mine ? [{ $or: [{ managerId: req.member._id }, { memberIds: req.member._id }] }] : []),
    ...(query.q ? [searchFilter(query.q, ['name', 'number'])] : []),
  ];
  const filter = {
    ...scope(req),
    ...(query.status && { status: query.status }),
    ...(query.managerId && { managerId: query.managerId }),
    ...(query.leadId && { leadId: query.leadId }),
    ...(query.contactId && { contactId: query.contactId }),
    ...(and.length && { $and: and }),
  };
  const page = toPage(query);
  const [items, total] = await Promise.all([
    Project.find(filter).sort({ status: 1, dueDate: 1, createdAt: -1 }).skip(page.skip).limit(page.limit),
    Project.countDocuments(filter),
  ]);
  const counts = await taskCounts(req.tenant.organizationId, items.map((p) => p._id));
  return { items: items.map((p) => serialize(p, counts.get(String(p._id)))), pagination: paginationMeta(page, total) };
}

async function get(req, id) {
  const project = await findVisible(req, id);
  return serialize(project, (await taskCounts(req.tenant.organizationId, [project._id])).get(String(project._id)));
}

async function update(req, id, body) {
  const project = await editable(req, id);
  const organizationId = req.tenant.organizationId;
  if (body.managerId !== undefined || body.memberIds !== undefined) {
    const managerId = body.managerId ?? project.managerId;
    project.memberIds = await activeMembers(organizationId, [managerId, ...(body.memberIds ?? project.memberIds)]);
    project.managerId = managerId;
  }
  for (const key of ['name', 'status', 'startDate', 'dueDate', 'description', 'valuePaise']) if (body[key] !== undefined) project[key] = body[key];
  if (body.status === 'completed' && !project.completedAt) project.completedAt = new Date();
  if (body.status && body.status !== 'completed') project.completedAt = undefined;
  await project.save();
  if (body.name) await Task.updateMany({ organizationId, relatedType: 'Project', relatedId: project._id }, { $set: { relatedName: project.name } });
  await audit(req, { action: 'project.updated', entityType: 'Project', entityId: project._id, changes: Object.keys(body) });
  return get(req, id);
}

// A deleted project lets its deal go (so the deal may start another) and takes its tasks along.
async function remove(req, id) {
  const project = await editable(req, id);
  await Project.updateOne({ _id: project._id }, { $set: { deletedAt: new Date(), ...(project.leadId && { formerLeadId: project.leadId }) }, $unset: { leadId: 1 } });
  await Task.updateMany({ organizationId: req.tenant.organizationId, relatedType: 'Project', relatedId: project._id, deletedAt: null }, { $set: { deletedAt: new Date() } });
  await audit(req, { action: 'project.deleted', entityType: 'Project', entityId: project._id, changes: { name: project.name } });
}

// Milestones: the manager (or an owner or admin) adds and removes; the team ticks them.
async function addMilestone(req, id, { name, dueDate = '' }) {
  const project = await editable(req, id);
  if (project.milestones.length >= 50) throw invalid('milestones', 'At most 50 milestones.', 'TOO_MANY');
  project.milestones.push({ name, dueDate });
  await project.save();
  return get(req, id);
}
async function updateMilestone(req, id, milestoneId, body) {
  const project = await findVisible(req, id);
  const milestone = project.milestones.id(milestoneId);
  if (!milestone) throw httpError(404, 'NOT_FOUND', 'Milestone not found');
  const onlyTicking = Object.keys(body).every((key) => key === 'done');
  if (!onlyTicking) await editable(req, id);
  if (body.name !== undefined) milestone.name = body.name;
  if (body.dueDate !== undefined) milestone.dueDate = body.dueDate;
  if (body.done !== undefined) {
    milestone.done = body.done;
    milestone.doneAt = body.done ? new Date() : undefined;
  }
  if (project.status === 'not_started' && body.done) project.status = 'in_progress';
  await project.save();
  return get(req, id);
}
async function removeMilestone(req, id, milestoneId) {
  const project = await editable(req, id);
  const milestone = project.milestones.id(milestoneId);
  if (!milestone) throw httpError(404, 'NOT_FOUND', 'Milestone not found');
  milestone.deleteOne();
  await project.save();
  await Task.updateMany({ organizationId: req.tenant.organizationId, relatedType: 'Project', relatedId: project._id, milestoneId }, { $unset: { milestoneId: 1 } });
  return get(req, id);
}

// The project's tasks (anyone on the project sees and ticks them, Tasks module or not).
async function listTasks(req, id) {
  const project = await findVisible(req, id);
  const tasks = await Task.find({ organizationId: req.tenant.organizationId, relatedType: 'Project', relatedId: project._id }).sort({ dueDate: 1, createdAt: 1 });
  return tasks.map((task) => ({ ...serializeTask(task), milestoneId: task.milestoneId || null }));
}
async function addTask(req, id, body) {
  const project = await findVisible(req, id);
  if (body.milestoneId && !project.milestones.id(body.milestoneId)) throw invalid('milestoneId', 'Pick one of this project\'s milestones.', 'INVALID_MILESTONE');
  if (body.assigneeId) await activeMembers(req.tenant.organizationId, [body.assigneeId]);
  const task = await Task.create({
    organizationId: req.tenant.organizationId, title: body.title, dueDate: body.dueDate || undefined, priority: body.priority || 'Medium', assigneeId: body.assigneeId || undefined,
    status: 'To Do', origin: 'project', relatedType: 'Project', relatedId: project._id, relatedName: project.name, milestoneId: body.milestoneId || undefined,
    createdById: req.user._id, createdByMemberId: req.member._id,
  });
  if (project.status === 'not_started') await Project.updateOne({ _id: project._id }, { $set: { status: 'in_progress' } });
  return { ...serializeTask(task), milestoneId: task.milestoneId || null };
}
async function updateTask(req, id, taskId, body) {
  const project = await findVisible(req, id);
  const task = await Task.findOne({ _id: taskId, organizationId: req.tenant.organizationId, relatedType: 'Project', relatedId: project._id });
  if (!task) throw httpError(404, 'NOT_FOUND', 'Task not found');
  if (body.status !== undefined) {
    task.status = body.status;
    task.completedAt = body.status === 'Done' ? new Date() : undefined;
  }
  if (body.title !== undefined) task.title = body.title;
  if (body.dueDate !== undefined) task.dueDate = body.dueDate || undefined;
  if (body.assigneeId !== undefined) task.assigneeId = body.assigneeId || undefined;
  await task.save();
  if (project.status === 'not_started' && body.status === 'Done') await Project.updateOne({ _id: project._id }, { $set: { status: 'in_progress' } });
  return { ...serializeTask(task), milestoneId: task.milestoneId || null };
}

// GET /projects/summary?leadId=|contactId= — for the deal box and Customer 360: the projects the
// member may see; for one who may not (no Projects module, or not on it), only how many exist.
async function summary(req, { leadId, contactId }) {
  const organizationId = req.tenant.organizationId;
  const where = { organizationId, ...(leadId && { leadId }), ...(contactId && { contactId }) };
  const total = await Project.countDocuments(where);
  if (!can(req.member, 'projects', 'view')) return { canView: false, count: total, items: [] };
  const visible = await Project.find({ ...where, ...scope(req) }).sort({ createdAt: -1 }).limit(20);
  const counts = await taskCounts(organizationId, visible.map((p) => p._id));
  return {
    canView: true,
    count: total,
    items: visible.map((p) => {
      const s = serialize(p, counts.get(String(p._id)));
      return { id: s.id, number: s.number, name: s.name, status: s.status, progress: s.progress, dueDate: s.dueDate, overdue: s.overdue, tasks: s.tasks };
    }),
  };
}

// --- templates and the "on Won" switch (owners and admins) -------------------------------------
const serializeTemplate = (t) => ({ id: t._id, name: t.name, days: t.days, milestones: t.milestones.map((m) => ({ name: m.name, dueAfterDays: m.dueAfterDays })), tasks: t.tasks.map((x) => ({ title: x.title, milestone: x.milestone, dueAfterDays: x.dueAfterDays, priority: x.priority, forManager: x.forManager })) });
function checkTemplate(body) {
  const count = (body.milestones || []).length;
  (body.tasks || []).forEach((task, index) => {
    if (Number.isInteger(task.milestone) && task.milestone >= count) throw invalid(`tasks.${index}.milestone`, `Task ${index + 1} points to a milestone that is not there.`, 'INVALID_MILESTONE');
  });
}
const listTemplates = async (req) => (await ProjectTemplate.find({ organizationId: req.tenant.organizationId }).sort({ name: 1 })).map(serializeTemplate);
async function createTemplate(req, body) {
  checkTemplate(body);
  const template = await ProjectTemplate.create({ ...body, organizationId: req.tenant.organizationId, createdById: req.user._id });
  await audit(req, { action: 'project_template.created', entityType: 'ProjectTemplate', entityId: template._id, changes: { name: template.name } });
  return serializeTemplate(template);
}
async function updateTemplate(req, id, body) {
  const template = mongoose.isValidObjectId(id) ? await ProjectTemplate.findOne({ _id: id, organizationId: req.tenant.organizationId }) : null;
  if (!template) throw httpError(404, 'NOT_FOUND', 'Template not found');
  checkTemplate({ milestones: body.milestones ?? template.milestones, tasks: body.tasks ?? template.tasks });
  Object.assign(template, body);
  await template.save();
  await audit(req, { action: 'project_template.updated', entityType: 'ProjectTemplate', entityId: template._id, changes: Object.keys(body) });
  return serializeTemplate(template);
}
async function removeTemplate(req, id) {
  const removed = mongoose.isValidObjectId(id) ? await ProjectTemplate.findOneAndDelete({ _id: id, organizationId: req.tenant.organizationId }) : null;
  if (!removed) throw httpError(404, 'NOT_FOUND', 'Template not found');
  // The automatic switch that used it starts projects without a template from now on.
  await Organization.updateOne({ _id: req.tenant.organizationId, 'settings.projectsOnWon.templateId': removed._id }, { $unset: { 'settings.projectsOnWon.templateId': 1 } });
  await audit(req, { action: 'project_template.deleted', entityType: 'ProjectTemplate', entityId: removed._id, changes: { name: removed.name } });
}

async function getSettings(req) {
  const organization = await Organization.findById(req.tenant.organizationId).select('settings.projectsOnWon');
  const s = organization?.settings?.projectsOnWon || {};
  return { onWon: { enabled: Boolean(s.enabled), templateId: s.templateId || null } };
}
async function saveSettings(req, { onWon }) {
  if (onWon.templateId) await templateFor(req.tenant.organizationId, onWon.templateId);
  await Organization.updateOne({ _id: req.tenant.organizationId }, { $set: { 'settings.projectsOnWon': { enabled: onWon.enabled, templateId: onWon.templateId || undefined } } });
  await audit(req, { action: 'projects.settings', entityType: 'Organization', entityId: req.tenant.organizationId, changes: onWon });
  return getSettings(req);
}

// --- on Won, by itself ------------------------------------------------------------------------
async function runWonJob({ organizationId, leadId }) {
  const organization = await Organization.findById(organizationId).select('settings.projectsOnWon');
  const setting = organization?.settings?.projectsOnWon;
  if (!setting?.enabled) return 'off';
  const lead = await Lead.findOne({ _id: leadId, organizationId });
  if (!lead || lead.stage !== 'Won') return 'not_won';
  const { created } = await startForLead({ organizationId, lead, actor: { userId: undefined, memberId: lead.ownerId }, templateId: setting.templateId });
  return created ? 'created' : 'exists';
}

let listener = null;
function register(queue) {
  queue.define(JOB, (data) => runWonJob(data), { maxAttempts: 4 });
  if (listener) bus.off('automation:event', listener);
  listener = (event) => {
    if (event.type !== 'lead.stage_changed' || event.to !== 'Won') return;
    Organization.exists({ _id: event.organizationId, 'settings.projectsOnWon.enabled': true })
      .then((on) => on && queue.enqueue(JOB, { organizationId: String(event.organizationId), leadId: String(event.leadId) }, { uniqueKey: `${JOB}:${event.leadId}`, organizationId: event.organizationId }))
      .catch((error) => logger.error(`A project for won lead ${event.leadId} could not be queued: ${error.message}`));
  };
  bus.on('automation:event', listener);
}

module.exports = {
  JOB, list, get, create, update, remove, startFromLead, runWonJob, register, summary,
  addMilestone, updateMilestone, removeMilestone, listTasks, addTask, updateTask,
  listTemplates, createTemplate, updateTemplate, removeTemplate, getSettings, saveSettings, progressOf,
};
