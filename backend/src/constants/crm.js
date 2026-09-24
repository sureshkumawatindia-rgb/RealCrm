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

module.exports = {
  LEAD_STAGES, OPEN_STAGES, STAGE_PROBABILITY, LEAD_SOURCES, CONTACT_LIFECYCLES, CONTACT_STATUSES, QUOTATION_STATUSES,
};
