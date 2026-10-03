// Business enums for the CRM core (roadmap decisions D3–D6, D13).

// One pipeline for leads and deals (D4, D13). Lost needs a reason.
const LEAD_STAGES = Object.freeze(['New', 'Contacted', 'Quote Sent', 'Negotiation', 'Won', 'Lost']);
const OPEN_STAGES = Object.freeze(['New', 'Contacted', 'Quote Sent', 'Negotiation']);
// The server sets probability from the stage; the browser never sends it.
const STAGE_PROBABILITY = Object.freeze({ New: 10, Contacted: 25, 'Quote Sent': 50, Negotiation: 75, Won: 100, Lost: 0 });

const LEAD_SOURCES = Object.freeze([
  'WhatsApp', 'IndiaMART', 'JustDial', 'TradeIndia', 'Facebook', 'Google Ads', 'Website', 'Manual', 'Import',
]);

const CONTACT_LIFECYCLES = Object.freeze(['lead', 'customer']);
const CONTACT_STATUSES = Object.freeze(['Active', 'Inactive']);

const QUOTATION_STATUSES = Object.freeze(['Draft', 'Sent', 'Viewed', 'Accepted', 'Rejected', 'Expired']);
// Phase 5: document types, each numbered on its own per financial year (e.g. QT/2026-27/0001).
const QUOTATION_TYPES = Object.freeze(['Quotation', 'Estimate', 'Proforma Invoice']);
// Orders (Phase 5): the pipeline in order, plus Cancelled.
const ORDER_FLOW = Object.freeze(['Received', 'Processing', 'Dispatched', 'Delivered', 'Payment Collected']);
const ORDER_STAGES = Object.freeze([...ORDER_FLOW, 'Cancelled']);

// Tasks and calendar events (same values the pages already show).
const TASK_STATUSES = Object.freeze(['To Do', 'In Progress', 'Done']);
const TASK_PRIORITIES = Object.freeze(['Low', 'Medium', 'High']);
// deal_followup: the quick follow-ups on the Deals page; automation: created by a workflow/sequence.
const TASK_ORIGINS = Object.freeze(['manual', 'deal_followup', 'automation']);
const EVENT_TYPES = Object.freeze(['Meeting', 'Call', 'Follow-up', 'Demo', 'Deadline', 'Reminder']);
// What a task/event is about. Customer/Contact → contacts, Lead/Deal → leads, Account = a company name.
const RELATED_TYPES = Object.freeze(['', 'Customer', 'Contact', 'Lead', 'Deal', 'Account']);

// Support tickets (same values the Support page shows). Numbers start at 1001, like the old page.
const TICKET_STATUSES = Object.freeze(['Open', 'In Progress', 'Waiting on Customer', 'Resolved', 'Closed']);
const TICKET_CLOSED_STATUSES = Object.freeze(['Resolved', 'Closed']);
const TICKET_PRIORITIES = Object.freeze(['Low', 'Medium', 'High', 'Urgent']);
const TICKET_CATEGORIES = Object.freeze(['Technical', 'Billing', 'General', 'Feature Request', 'Bug Report']);
const TICKET_NUMBER_START = 1001;
// Notes belong to a ticket, a contact, a campaign or a WhatsApp conversation (internal, never
// sent to the customer). Notes on a lead are lead activities.
const NOTE_PARENT_TYPES = Object.freeze(['ticket', 'contact', 'campaign', 'conversation']);

// Marketing campaigns and automation settings (same values the pages show). Workflows and
// sequences are settings only: "Run Now" / "Enroll" create tasks; the other actions are
// simulated until the automation engine (Phase 6).
const CAMPAIGN_TYPES = Object.freeze(['Email', 'Social', 'SMS', 'Ads', 'Event']);
const CAMPAIGN_STATUSES = Object.freeze(['Draft', 'Scheduled', 'Active', 'Paused', 'Completed']);
const AUTOMATION_STATUSES = Object.freeze(['Active', 'Paused', 'Draft']);
const WORKFLOW_TRIGGERS = Object.freeze([
  'Lead Created', 'Lead Status Changed to Won', 'Deal Created', 'Deal Stage Changed to Won',
  'Deal Stage Changed to Lost', 'Task Overdue', 'Customer Added',
]);
const WORKFLOW_ACTIONS = Object.freeze(['Create Task', 'Send Email (simulated)', 'Notify Agent', 'Update Status', 'Add to Sequence']);
const SEQUENCE_TARGETS = Object.freeze(['Leads', 'Deals', 'Customers']);
const SEQUENCE_STEP_TYPES = Object.freeze(['Email', 'Call', 'Task', 'Wait']);

// Documents (same categories the Documents page shows). Programs and scripts are refused:
// a CRM is no place to pass them around, even though downloads never run in the browser.
const DOCUMENT_CATEGORIES = Object.freeze(['Contract', 'Invoice', 'Proposal', 'Report', 'Template', 'Other']);
const BLOCKED_FILE_EXTENSIONS = Object.freeze([
  'exe', 'msi', 'msp', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'dll', 'sys', 'ps1', 'psm1', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'sh', 'apk', 'lnk', 'reg',
]);

module.exports = {
  LEAD_STAGES, OPEN_STAGES, STAGE_PROBABILITY, LEAD_SOURCES, CONTACT_LIFECYCLES, CONTACT_STATUSES, QUOTATION_STATUSES, QUOTATION_TYPES, ORDER_FLOW, ORDER_STAGES,
  TASK_STATUSES, TASK_PRIORITIES, TASK_ORIGINS, EVENT_TYPES, RELATED_TYPES,
  TICKET_STATUSES, TICKET_CLOSED_STATUSES, TICKET_PRIORITIES, TICKET_CATEGORIES, TICKET_NUMBER_START, NOTE_PARENT_TYPES,
  DOCUMENT_CATEGORIES, BLOCKED_FILE_EXTENSIONS,
  CAMPAIGN_TYPES, CAMPAIGN_STATUSES, AUTOMATION_STATUSES, WORKFLOW_TRIGGERS, WORKFLOW_ACTIONS,
  SEQUENCE_TARGETS, SEQUENCE_STEP_TYPES,
};
