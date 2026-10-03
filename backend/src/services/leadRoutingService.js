const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const bus = require('../realtime/bus');
const logger = require('../config/logger');
const assignment = require('./assignmentService');
const autoReply = require('./autoReplyService');
const automationEvents = require('./automation/events');

// What happens after an enquiry is taken (lead intake emits "lead:intake"): a job assigns the
// lead by the assignment rules (only if nobody owns it yet), then schedules the auto-reply, so
// the reply's chat already belongs to the lead's owner. Jobs retry if something fails. Rules look
// at the source of this enquiry (a repeat enquiry may join a lead that came from elsewhere).
const ROUTE = 'lead.route';

async function route(queue, { leadId, source, contactCreated, receivedAt, sourceRef, created }) {
  const lead = await Lead.findById(leadId);
  if (!lead) return;
  if (!lead.ownerId) {
    const contact = await Contact.findById(lead.contactId);
    const decision = await assignment.pickOwner(lead, contact, { source });
    await assignment.assignLead(lead, contact, decision);
  }
  const current = await Lead.findById(leadId);
  await autoReply.schedule(queue, current, { source, contactCreated, receivedAt, sourceRef });
  if (created) automationEvents.emit('lead.created', { organizationId: current.organizationId, leadId, contactId: current.contactId, source, key: `lead.created:${leadId}` });
}

let listener = null;
// Starts routing new enquiries through the queue (the server and tests call this once).
function attach(queue) {
  queue.define(ROUTE, (data) => route(queue, data), { maxAttempts: 5 });
  queue.define(autoReply.JOB, autoReply.send, { maxAttempts: 3 });
  if (listener) bus.off('lead:intake', listener);
  listener = (event) => {
    if (event.outcome !== 'created' && event.outcome !== 'attached') return;
    queue.enqueue(ROUTE, {
      leadId: String(event.leadId), source: event.source, contactCreated: Boolean(event.contactCreated), receivedAt: event.receivedAt || new Date(), sourceRef: event.sourceRef || '',
      created: event.outcome === 'created',
    }, { uniqueKey: `route:${event.leadId}:${event.sourceRef || ''}`, organizationId: event.organizationId })
      .catch((error) => logger.error(`Routing lead ${event.leadId} failed to start: ${error.message}`));
  };
  bus.on('lead:intake', listener);
}

module.exports = { ROUTE, route, attach };
