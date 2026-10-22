// Microsoft 365 and Teams (Phase 4B, D83).

// The business events a Teams channel can hear about. Each is one of the automation bus events,
// narrowed where needed (a lead stage change only when it is Won).
const TEAMS_EVENTS = Object.freeze(['lead.created', 'lead.won', 'quotation.accepted', 'payment.received', 'ticket.created']);
const TEAMS_EVENT_LABELS = Object.freeze({
  'lead.created': 'A new lead',
  'lead.won': 'A lead is won',
  'quotation.accepted': 'A quotation is accepted',
  'payment.received': 'A payment is received',
  'ticket.created': 'A support ticket is opened',
});

// Teams Workflows ("Post to a channel when a webhook request is received") and the older incoming
// webhooks answer only on these hosts; nothing else is accepted as a Teams address.
const TEAMS_HOSTS = Object.freeze([/\.logic\.azure\.com$/i, /\.powerplatform\.com$/i, /\.webhook\.office\.com$/i]);

module.exports = { TEAMS_EVENTS, TEAMS_EVENT_LABELS, TEAMS_HOSTS };
