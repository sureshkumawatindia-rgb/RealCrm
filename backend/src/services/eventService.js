const CalendarEvent = require('../models/CalendarEvent');
const httpError = require('../utils/httpError');
const { createWorkItemService } = require('./workItemService');

// Events show on the Calendar and also on the dashboard, Customer 360 and reports.
const MODULES = ['calendar', 'dashboard', 'customers', 'reports'];

function serializeEvent(event) {
  return {
    id: event._id,
    title: event.title,
    type: event.type,
    date: event.date,
    startTime: event.startTime,
    endTime: event.endTime,
    timezone: event.timezone,
    assigneeId: event.assigneeId || null,
    assigneeName: event.assigneeName,
    relatedType: event.relatedType,
    relatedId: event.relatedId || null,
    relatedName: event.relatedName,
    description: event.description,
    createdByMemberId: event.createdByMemberId || null,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

module.exports = {
  MODULES,
  serializeEvent,
  ...createWorkItemService({
    Model: CalendarEvent,
    modules: MODULES,
    entityType: 'CalendarEvent',
    label: 'Event',
    fields: ['title', 'type', 'date', 'startTime', 'endTime', 'description'],
    searchFields: ['title', 'description', 'relatedName', 'assigneeName'],
    sorts: ['date', 'createdAt', 'title'],
    defaultSort: { date: 1, startTime: 1, _id: 1 },
    filters: (query) => ({
      ...(query.type && { type: query.type }),
      ...(query.assigneeId && { assigneeId: query.assigneeId }),
      ...(query.relatedType && { relatedType: query.relatedType }),
      ...(query.relatedId && { relatedId: query.relatedId }),
      ...((query.from || query.to) && { date: { ...(query.from && { $gte: query.from }), ...(query.to && { $lte: query.to }) } }),
    }),
    prepare(event) {
      if (!event.startTime) event.endTime = '';
      if (event.startTime && event.endTime && event.endTime <= event.startTime) {
        throw httpError(400, 'VALIDATION_ERROR', 'The end time must be after the start time.', [{ field: 'endTime', code: 'END_BEFORE_START', message: 'Pick an end time after the start time.' }]);
      }
    },
    serialize: serializeEvent,
  }),
};
