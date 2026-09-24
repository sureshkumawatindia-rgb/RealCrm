const Task = require('../models/Task');
const { createWorkItemService } = require('./workItemService');

// Tasks show on the Tasks page and also on Calendar, Deals (follow-ups), the dashboard,
// Customer 360 and reports, so any of those modules may read them.
const MODULES = ['tasks', 'calendar', 'deals', 'dashboard', 'customers', 'reports'];

function serializeTask(task) {
  return {
    id: task._id,
    title: task.title,
    description: task.description,
    assigneeId: task.assigneeId || null,
    assigneeName: task.assigneeName,
    dueDate: task.dueDate || '',
    priority: task.priority,
    status: task.status,
    completedAt: task.completedAt || null,
    relatedType: task.relatedType,
    relatedId: task.relatedId || null,
    relatedName: task.relatedName,
    origin: task.origin,
    createdByMemberId: task.createdByMemberId || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

module.exports = {
  MODULES,
  serializeTask,
  ...createWorkItemService({
    Model: Task,
    modules: MODULES,
    entityType: 'Task',
    label: 'Task',
    fields: ['title', 'description', 'dueDate', 'priority', 'status', 'origin'],
    searchFields: ['title', 'description', 'relatedName', 'assigneeName'],
    sorts: ['dueDate', 'createdAt', 'updatedAt', 'priority', 'title'],
    defaultSort: { createdAt: -1 },
    filters: (query) => ({
      ...(query.status && { status: query.status }),
      ...(query.priority && { priority: query.priority }),
      ...(query.assigneeId && { assigneeId: query.assigneeId }),
      ...(query.origin && { origin: query.origin }),
      ...(query.relatedType && { relatedType: query.relatedType }),
      ...(query.relatedId && { relatedId: query.relatedId }),
      ...((query.dueFrom || query.dueTo) && { dueDate: { ...(query.dueFrom && { $gte: query.dueFrom }), ...(query.dueTo && { $lte: query.dueTo }) } }),
    }),
    // Done records when it was completed; reopening clears it.
    prepare(task) {
      if (task.status === 'Done' && !task.completedAt) task.completedAt = new Date();
      if (task.status !== 'Done') task.completedAt = undefined;
    },
    serialize: serializeTask,
  }),
};
