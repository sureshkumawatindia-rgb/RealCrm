// WhatsApp Cloud API values used by the inbox (Phase 3).

// "meta": the real Cloud API. "mock": a local stand-in for development without a Meta account
// (never allowed in production).
const WHATSAPP_PROVIDERS = Object.freeze(['meta', 'mock']);
const ACCOUNT_STATUSES = Object.freeze(['pending', 'connected', 'error']);

const CONVERSATION_STATUSES = Object.freeze(['open', 'pending', 'closed']);

// Message types from the webhook reference; anything else is stored as "unsupported".
const MESSAGE_TYPES = Object.freeze([
  'text', 'image', 'document', 'audio', 'video', 'sticker', 'location', 'contacts',
  'interactive', 'button', 'reaction', 'template', 'order', 'unsupported',
]);
const MEDIA_TYPES = Object.freeze(['image', 'document', 'audio', 'video', 'sticker']);

// Outbound delivery progress. A status webhook never moves a message backwards.
const MESSAGE_STATUSES = Object.freeze(['received', 'queued', 'sent', 'delivered', 'read', 'failed']);
const STATUS_RANK = Object.freeze({ received: 0, queued: 1, sent: 2, failed: 3, delivered: 4, read: 5 });

// The customer service window: free-form messages only within 24 hours of the customer's last message.
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Files we can send, by extension: WhatsApp's media type, the MIME type we tell Meta, and
// Meta's size limit (Cloud API "Supported media types", checked 2026-09-29).
const MB = 1024 * 1024;
const OUTBOUND_MEDIA = Object.freeze({
  jpg: { type: 'image', mimeType: 'image/jpeg', maxBytes: 5 * MB },
  jpeg: { type: 'image', mimeType: 'image/jpeg', maxBytes: 5 * MB },
  png: { type: 'image', mimeType: 'image/png', maxBytes: 5 * MB },
  mp4: { type: 'video', mimeType: 'video/mp4', maxBytes: 16 * MB },
  '3gp': { type: 'video', mimeType: 'video/3gpp', maxBytes: 16 * MB },
  aac: { type: 'audio', mimeType: 'audio/aac', maxBytes: 16 * MB },
  amr: { type: 'audio', mimeType: 'audio/amr', maxBytes: 16 * MB },
  mp3: { type: 'audio', mimeType: 'audio/mpeg', maxBytes: 16 * MB },
  m4a: { type: 'audio', mimeType: 'audio/mp4', maxBytes: 16 * MB },
  ogg: { type: 'audio', mimeType: 'audio/ogg', maxBytes: 16 * MB },
  pdf: { type: 'document', mimeType: 'application/pdf', maxBytes: 100 * MB },
  doc: { type: 'document', mimeType: 'application/msword', maxBytes: 100 * MB },
  docx: { type: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', maxBytes: 100 * MB },
  xls: { type: 'document', mimeType: 'application/vnd.ms-excel', maxBytes: 100 * MB },
  xlsx: { type: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', maxBytes: 100 * MB },
  ppt: { type: 'document', mimeType: 'application/vnd.ms-powerpoint', maxBytes: 100 * MB },
  pptx: { type: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', maxBytes: 100 * MB },
  txt: { type: 'document', mimeType: 'text/plain', maxBytes: 100 * MB },
});
// The largest file WhatsApp carries (documents); incoming files above it are not downloaded.
const MEDIA_MAX_BYTES = 100 * MB;

// Categories a template can be created in here (authentication templates need one-time-code
// buttons, which this CRM does not create).
const TEMPLATE_CATEGORIES = Object.freeze(['MARKETING', 'UTILITY']);

module.exports = {
  WHATSAPP_PROVIDERS, ACCOUNT_STATUSES, CONVERSATION_STATUSES, MESSAGE_TYPES, MEDIA_TYPES,
  MESSAGE_STATUSES, STATUS_RANK, SERVICE_WINDOW_MS, OUTBOUND_MEDIA, MEDIA_MAX_BYTES, TEMPLATE_CATEGORIES,
};
