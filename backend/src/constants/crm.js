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
// Notes belong to a ticket or a contact (notes on a lead are lead activities).
const NOTE_PARENT_TYPES = Object.freeze(['ticket', 'contact']);

// Documents (same categories the Documents page shows). Programs and scripts are refused:
// a CRM is no place to pass them around, even though downloads never run in the browser.
const DOCUMENT_CATEGORIES = Object.freeze(['Contract', 'Invoice', 'Proposal', 'Report', 'Template', 'Other']);
const BLOCKED_FILE_EXTENSIONS = Object.freeze([
  'exe', 'msi', 'msp', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'dll', 'sys', 'ps1', 'psm1', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'sh', 'apk', 'lnk', 'reg',
]);

module.exports = {
  LEAD_STAGES, OPEN_STAGES, STAGE_PROBABILITY, LEAD_SOURCES, CONTACT_LIFECYCLES, CONTACT_STATUSES, QUOTATION_STATUSES,
  TASK_STATUSES, TASK_PRIORITIES, TASK_ORIGINS, EVENT_TYPES, RELATED_TYPES,
  TICKET_STATUSES, TICKET_CLOSED_STATUSES, TICKET_PRIORITIES, TICKET_CATEGORIES, TICKET_NUMBER_START, NOTE_PARENT_TYPES,
  DOCUMENT_CATEGORIES, BLOCKED_FILE_EXTENSIONS,
};
