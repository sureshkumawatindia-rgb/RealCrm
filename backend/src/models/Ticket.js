const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { TICKET_STATUSES, TICKET_PRIORITIES, TICKET_CATEGORIES } = require('../constants/crm');

// A support ticket. The number comes from the organization's "ticket" counter (#1001, #1002, ...)
// and is never reused, so the unique index also covers deleted tickets.
const ticketSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    number: { type: Number, required: true },
    // An imported ticket whose old number was already taken gets a new one and keeps the old here.
    legacyNumber: { type: Number },
    subject: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
    // The customer's name when the ticket was saved; the only link when no contact matched.
    customerName: { type: String, trim: true, default: '' },
    category: { type: String, enum: TICKET_CATEGORIES, default: 'General' },
    priority: { type: String, enum: TICKET_PRIORITIES, default: 'Medium' },
    status: { type: String, enum: TICKET_STATUSES, default: 'Open' },
    assigneeId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    // Only for imported tickets whose assignee is not a team member yet.
    assigneeName: { type: String, trim: true, default: '' },
    dueDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    resolvedAt: { type: Date },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
  },
  { timestamps: true },
);

ticketSchema.plugin(softDelete);
ticketSchema.index({ organizationId: 1, number: 1 }, { unique: true });
ticketSchema.index({ organizationId: 1, deletedAt: 1, status: 1, priority: 1, dueDate: 1 });
ticketSchema.index({ organizationId: 1, assigneeId: 1, status: 1 });
ticketSchema.index({ organizationId: 1, contactId: 1, createdAt: -1 });
ticketSchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('Ticket', ticketSchema);
