const Ticket = require('../models/Ticket');
const Contact = require('../models/Contact');
const httpError = require('../utils/httpError');
const { nextSequence } = require('../utils/counter');
const { createWorkItemService } = require('./workItemService');
const { TICKET_CLOSED_STATUSES, TICKET_NUMBER_START } = require('../constants/crm');

// Tickets show on Support, Customer 360 and reports, so any of those modules may read them.
const MODULES = ['support', 'customers', 'reports'];

function serializeTicket(ticket) {
  return {
    id: ticket._id,
    number: ticket.number,
    legacyNumber: ticket.legacyNumber ?? null,
    subject: ticket.subject,
    description: ticket.description,
    contactId: ticket.contactId || null,
    customerName: ticket.customerName,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    assigneeId: ticket.assigneeId || null,
    assigneeName: ticket.assigneeName,
    dueDate: ticket.dueDate || '',
    resolvedAt: ticket.resolvedAt || null,
    createdByMemberId: ticket.createdByMemberId || null,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

// Links the ticket to a contact (whose current name is kept as customerName), or keeps a typed
// name when there is no contact. A contactId always wins over a typed name.
async function resolveCustomer(req, ticket, body) {
  if (!('contactId' in body) && !('customerName' in body)) return;
  const contactId = 'contactId' in body ? body.contactId : ticket.contactId;
  if (!contactId) {
    ticket.contactId = undefined;
    if ('customerName' in body) ticket.customerName = body.customerName;
    return;
  }
  const contact = await Contact.findOne({ _id: contactId, organizationId: req.tenant.organizationId }).select('name');
  if (!contact) {
    throw httpError(400, 'VALIDATION_ERROR', 'Unknown customer.', [{ field: 'contactId', code: 'INVALID_CONTACT', message: 'Pick an existing customer.' }]);
  }
  ticket.contactId = contact._id;
  ticket.customerName = contact.name;
}

module.exports = {
  MODULES,
  serializeTicket,
  ...createWorkItemService({
    Model: Ticket,
    modules: MODULES,
    entityType: 'Ticket',
    label: 'Ticket',
    fields: ['subject', 'description', 'category', 'priority', 'status', 'dueDate'],
    searchFields: ['subject', 'description', 'customerName', 'assigneeName'],
    sorts: ['number', 'dueDate', 'createdAt', 'updatedAt', 'priority', 'status'],
    defaultSort: { createdAt: -1 },
    filters: (query) => ({
      ...(query.status && { status: query.status }),
      ...(query.priority && { priority: query.priority }),
      ...(query.category && { category: query.category }),
      ...(query.assigneeId && { assigneeId: query.assigneeId }),
      ...(query.contactId && { contactId: query.contactId }),
    }),
    resolve: resolveCustomer,
    // Numbers are handed out atomically, so two people saving at once never share one.
    async beforeCreate(req, ticket) {
      ticket.number = await nextSequence(req.tenant.organizationId, 'ticket', { start: TICKET_NUMBER_START });
    },
    // Resolved or Closed records when; reopening clears it.
    prepare(ticket) {
      const closed = TICKET_CLOSED_STATUSES.includes(ticket.status);
      if (closed && !ticket.resolvedAt) ticket.resolvedAt = new Date();
      if (!closed) ticket.resolvedAt = undefined;
    },
    serialize: serializeTicket,
  }),
};
