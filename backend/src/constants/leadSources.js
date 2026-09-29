// Lead sources (Phase 4): the connection types an organization can set up, and what each one
// becomes as a lead source (constants/crm.js LEAD_SOURCES).
const CONNECTION_TYPES = Object.freeze({
  website: 'Website',
  indiamart: 'IndiaMART',
  facebook: 'Facebook',
  googleads: 'Google Ads',
  justdial: 'JustDial',
  tradeindia: 'TradeIndia',
});
const CONNECTION_STATUSES = Object.freeze(['active', 'paused', 'error']);

// What happened to one incoming enquiry (lead intake log).
const INTAKE_OUTCOMES = Object.freeze(['processing', 'created', 'attached', 'rejected', 'failed']);

// The raw payload kept with each enquiry is cut at this size.
const RAW_PAYLOAD_MAX_BYTES = 20 * 1024;

module.exports = { CONNECTION_TYPES, CONNECTION_STATUSES, INTAKE_OUTCOMES, RAW_PAYLOAD_MAX_BYTES };
