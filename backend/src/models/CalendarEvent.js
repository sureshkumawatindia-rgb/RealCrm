const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { EVENT_TYPES, RELATED_TYPES } = require('../constants/crm');

// A calendar entry. date is the calendar day (YYYY-MM-DD) and times are HH:MM wall-clock
// times in the organization's timezone; an event without a start time lasts the whole day.
const calendarEventSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    title: { type: String, required: true, trim: true },
    type: { type: String, enum: EVENT_TYPES, default: 'Meeting' },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    startTime: { type: String, default: '', match: /^(\d{2}:\d{2})?$/ },
    endTime: { type: String, default: '', match: /^(\d{2}:\d{2})?$/ },
    timezone: { type: String, default: 'Asia/Kolkata' },
    assigneeId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    assigneeName: { type: String, trim: true, default: '' },
    relatedType: { type: String, enum: RELATED_TYPES, default: '' },
    relatedId: { type: mongoose.Schema.Types.ObjectId },
    relatedName: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
  },
  { timestamps: true },
);

calendarEventSchema.plugin(softDelete);
calendarEventSchema.index({ organizationId: 1, deletedAt: 1, date: 1 });
calendarEventSchema.index({ organizationId: 1, assigneeId: 1, date: 1 });
calendarEventSchema.index({ organizationId: 1, relatedType: 1, relatedId: 1 });
calendarEventSchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('CalendarEvent', calendarEventSchema);
