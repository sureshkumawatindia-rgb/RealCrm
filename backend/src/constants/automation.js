// The automation engine's vocabulary (Phase 6): what can start a workflow, what it may check,
// and what it can do. Labels are what the Sales Automation page shows.

// kind: event = the moment it happens; time = found by the scan every few minutes.
const TRIGGERS = Object.freeze({
  'lead.created': { label: 'A lead is created', kind: 'event' },
  'message.received': { label: 'A WhatsApp message arrives', kind: 'event' },
  'lead.stage_changed': { label: 'A lead changes stage', kind: 'event' },
  'lead.no_reply': { label: 'The customer has not replied for some hours', kind: 'time' },
  'quotation.not_accepted': { label: 'A sent quotation is not accepted after some days', kind: 'time' },
  'order.stage_changed': { label: 'An order changes stage', kind: 'event' },
  'payment.received': { label: 'A payment is received', kind: 'event' },
  'task.overdue': { label: 'A task is overdue', kind: 'time' },
});
const TRIGGER_TYPES = Object.freeze(Object.keys(TRIGGERS));

const CONDITION_FIELDS = Object.freeze({
  source: { label: 'Lead source', ops: ['in', 'notIn'] },
  tag: { label: 'Customer tag', ops: ['has', 'hasNot'] },
  stage: { label: 'Lead stage', ops: ['in', 'notIn'] },
  owner: { label: 'Lead owner', ops: ['is', 'isNot', 'none', 'any'] },
  businessHours: { label: 'Working hours', ops: ['open', 'closed'] },
});

const ACTIONS = Object.freeze({
  'whatsapp.text': 'Send a WhatsApp message (only within 24 hours of the customer\'s last message)',
  'whatsapp.template': 'Send an approved WhatsApp template',
  assign: 'Give the lead to someone',
  'tag.add': 'Add a tag to the customer',
  'tag.remove': 'Remove a tag from the customer',
  'stage.change': 'Move the lead to a stage',
  'task.create': 'Create a task',
  'agent.notify': 'Notify someone in the CRM',
  wait: 'Wait',
  'webhook.call': 'Call a webhook',
});
const ACTION_TYPES = Object.freeze(Object.keys(ACTIONS));

const RUN_STATUSES = Object.freeze(['running', 'waiting', 'done', 'failed', 'skipped', 'cancelled']);
// Events that automations cause may start other automations, but not endlessly.
const MAX_CHAIN = 4;

module.exports = { TRIGGERS, TRIGGER_TYPES, CONDITION_FIELDS, ACTIONS, ACTION_TYPES, RUN_STATUSES, MAX_CHAIN };
