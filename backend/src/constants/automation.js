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
  'payment.overdue': { label: 'An order is still not paid after some days', kind: 'time' },
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
  'sequence.enroll': 'Add the customer to a sequence',
  'payment.link': 'Send the order\'s payment link on WhatsApp',
});
const ACTION_TYPES = Object.freeze(Object.keys(ACTIONS));

// Sequences (Phase 6B): follow-ups per customer on day 0, 2, 5 … that stop when the customer
// replies. Their steps are workflow actions without waits (the day is the wait), webhooks or
// sequences.
const SEQUENCE_STEP_TYPES = Object.freeze(['whatsapp.text', 'whatsapp.template', 'task.create', 'agent.notify', 'tag.add', 'tag.remove', 'stage.change', 'assign', 'payment.link']);
const ENROLLMENT_STATUSES = Object.freeze(['active', 'completed', 'stopped', 'failed']);

const RUN_STATUSES = Object.freeze(['running', 'waiting', 'done', 'failed', 'skipped', 'cancelled']);
// Events that automations cause may start other automations, but not endlessly.
const MAX_CHAIN = 4;

// Ready-made workflows to start from (Phase 7A, D86). Choices that are the company's own (who,
// which template) are left empty: the builder's check says what to pick. The page shows each
// recipe's name and description in the person's language (by id).
const WORKFLOW_RECIPES = Object.freeze([
  {
    id: 'portal-lead-owner', name: 'Give IndiaMART and TradeIndia leads to one person', description: 'A new lead from a portal goes to the person you pick, with a task to call within the day.',
    trigger: { type: 'lead.created', params: { sources: ['IndiaMART', 'TradeIndia', 'JustDial'] } }, conditions: [],
    steps: [
      { type: 'assign', params: { memberId: '' } },
      { type: 'task.create', params: { title: 'Call {{contact.name}} about {{lead.title}}', dueInDays: 0, assignTo: 'owner', priority: 'High' } },
    ],
  },
  {
    id: 'welcome-template', name: 'Welcome every new lead on WhatsApp', description: 'Sends your approved welcome template at once, and reminds the owner to call.',
    trigger: { type: 'lead.created', params: {} }, conditions: [],
    steps: [
      { type: 'whatsapp.template', params: { templateId: '', variables: {} } },
      { type: 'task.create', params: { title: 'Call {{contact.name}}', dueInDays: 0, assignTo: 'owner', priority: 'Medium' } },
    ],
  },
  {
    id: 'no-reply-nudge', name: 'Nudge the owner when a customer goes quiet', description: 'After a day without a reply on an open lead: a bell note and a follow-up task for the owner.',
    trigger: { type: 'lead.no_reply', params: { hours: 24 } }, conditions: [{ field: 'stage', op: 'notIn', value: ['Won', 'Lost'] }],
    steps: [
      { type: 'agent.notify', params: { to: 'owner', message: '{{contact.name}} has not replied for a day.' } },
      { type: 'task.create', params: { title: 'Follow up with {{contact.name}}', dueInDays: 0, assignTo: 'owner', priority: 'Medium' } },
    ],
  },
  {
    id: 'quotation-chase', name: 'Chase a quotation that is not accepted', description: 'Three days after a quotation is sent and not accepted: a task and a bell note for the owner.',
    trigger: { type: 'quotation.not_accepted', params: { days: 3 } }, conditions: [],
    steps: [
      { type: 'task.create', params: { title: 'Follow up on quotation {{quotation.number}} ({{quotation.total}})', dueInDays: 0, assignTo: 'owner', priority: 'High' } },
      { type: 'agent.notify', params: { to: 'owner', message: 'Quotation {{quotation.number}} for {{contact.name}} is still not accepted.' } },
    ],
  },
  {
    id: 'payment-reminder', name: 'Send the payment link when an order is not paid', description: 'A week after an order with money due: its payment link on WhatsApp.',
    trigger: { type: 'payment.overdue', params: { days: 7 } }, conditions: [],
    steps: [{ type: 'payment.link', params: {} }],
  },
  {
    id: 'won-celebrate', name: 'Tag the customer and tell the managers when a deal is won', description: 'Won: the customer gets the tag "customer", and owners and admins get a bell note.',
    trigger: { type: 'lead.stage_changed', params: { toStages: ['Won'] } }, conditions: [],
    steps: [
      { type: 'tag.add', params: { tag: 'customer' } },
      { type: 'agent.notify', params: { to: 'managers', message: '{{owner.name}} won {{lead.title}} with {{contact.name}}.' } },
    ],
  },
]);

module.exports = { TRIGGERS, TRIGGER_TYPES, CONDITION_FIELDS, ACTIONS, ACTION_TYPES, RUN_STATUSES, MAX_CHAIN, SEQUENCE_STEP_TYPES, ENROLLMENT_STATUSES, WORKFLOW_RECIPES };
