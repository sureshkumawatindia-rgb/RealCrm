// The public API and outbound webhooks (Phase 10C), as data.

// What an API key may do (chosen when it is made; a key acts for the whole company).
const API_SCOPES = Object.freeze({
  'contacts:read': 'Read customers',
  'contacts:write': 'Add and change customers',
  'leads:read': 'Read leads',
  'leads:write': 'Add leads and change their stage',
  'quotations:read': 'Read quotations',
  'orders:read': 'Read orders and their payments',
  'products:read': 'Read products',
  'messages:write': 'Send approved WhatsApp templates',
});
const API_SCOPE_KEYS = Object.freeze(Object.keys(API_SCOPES));

// What outbound webhooks can be told about.
const WEBHOOK_EVENTS = Object.freeze({
  'lead.created': 'A lead is created (any source)',
  'lead.stage_changed': 'A lead moves to another stage',
  'contact.created': 'A customer is added',
  'message.received': 'A customer writes on WhatsApp',
  'quotation.status_changed': 'A quotation is sent, viewed, accepted, rejected or expires',
  'order.created': 'An order is created',
  'order.stage_changed': 'An order moves to another stage',
  'payment.received': 'A payment is received',
});
const WEBHOOK_EVENT_KEYS = Object.freeze(Object.keys(WEBHOOK_EVENTS));

module.exports = { API_SCOPES, API_SCOPE_KEYS, WEBHOOK_EVENTS, WEBHOOK_EVENT_KEYS };
