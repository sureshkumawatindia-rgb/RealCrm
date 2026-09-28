// WhatsApp Cloud API values used by the inbox (Phase 3).

// "meta": the real Cloud API. "mock": a local stand-in for development without a Meta account
// (never allowed in production).
const WHATSAPP_PROVIDERS = Object.freeze(['meta', 'mock']);
const ACCOUNT_STATUSES = Object.freeze(['pending', 'connected', 'error']);

const CONVERSATION_STATUSES = Object.freeze(['open', 'pending', 'closed']);

// Message types from the webhook reference; anything else is stored as "unsupported".
const MESSAGE_TYPES = Object.freeze([
  'text', 'image', 'document', 'audio', 'video', 'sticker', 'location', 'contacts',
  'interactive', 'button', 'reaction', 'template', 'unsupported',
]);
const MEDIA_TYPES = Object.freeze(['image', 'document', 'audio', 'video', 'sticker']);

// Outbound delivery progress. A status webhook never moves a message backwards.
const MESSAGE_STATUSES = Object.freeze(['received', 'queued', 'sent', 'delivered', 'read', 'failed']);
const STATUS_RANK = Object.freeze({ received: 0, queued: 1, sent: 2, failed: 3, delivered: 4, read: 5 });

// The customer service window: free-form messages only within 24 hours of the customer's last message.
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

module.exports = {
  WHATSAPP_PROVIDERS, ACCOUNT_STATUSES, CONVERSATION_STATUSES, MESSAGE_TYPES, MEDIA_TYPES,
  MESSAGE_STATUSES, STATUS_RANK, SERVICE_WINDOW_MS,
};
