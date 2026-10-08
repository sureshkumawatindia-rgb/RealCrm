const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { WHATSAPP_PROVIDERS, ACCOUNT_STATUSES } = require('../constants/whatsapp');

// A WhatsApp Business phone number connected to an organization (Settings → WhatsApp).
// Meta calls our webhook at /api/v1/webhooks/whatsapp/<webhookKey>; the verify token answers
// Meta's handshake and the app secret checks every POST. Secrets are encrypted (secretBox)
// and never sent to the browser in full.
const whatsappAccountSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, trim: true, default: '' },
    provider: { type: String, enum: WHATSAPP_PROVIDERS, default: 'meta' },
    phoneNumberId: { type: String, required: true, trim: true },
    // Set while the account is active: a number belongs to one organization at a time.
    activePhoneNumberId: { type: String },
    wabaId: { type: String, trim: true, default: '' },
    displayPhone: { type: String, trim: true, default: '' },
    verifiedName: { type: String, trim: true, default: '' },
    qualityRating: { type: String, trim: true, default: '' },
    // Meta's daily limit of people reached with templates (Phase 7): TIER_250 … TIER_UNLIMITED.
    messagingLimit: { type: String, trim: true, default: '' },
    accessTokenEnc: { type: String },
    accessTokenLast4: { type: String, default: '' },
    appSecretEnc: { type: String },
    verifyTokenEnc: { type: String, required: true },
    webhookKey: { type: String, required: true },
    status: { type: String, enum: ACCOUNT_STATUSES, default: 'pending' },
    statusMessage: { type: String, default: '' },
    lastWebhookAt: { type: Date },
    isDefault: { type: Boolean, default: false },
    // How the number was connected (D60): manual = the IDs and token pasted in Settings (its own
    // Meta app and webhook URL); embedded = "Connect WhatsApp" with a new number; coexistence =
    // "Connect WhatsApp" with the WhatsApp Business app number (the app keeps working, chats sync).
    // Embedded and coexistence numbers use the platform's app and /api/v1/webhooks/meta.
    connectionType: { type: String, enum: ['manual', 'embedded', 'coexistence'], default: 'manual' },
    connectedAt: { type: Date },
    registrationPinEnc: { type: String }, // a new number's two-step PIN (secretBox)
    // Importing a coexistence number's contacts and chats (Meta sends up to 6 months of history
    // in phases 0–2 with a progress percentage; the business may decline sharing it).
    sync: {
      status: { type: String, enum: ['pending', 'importing', 'done', 'declined', 'failed'] },
      requestedAt: { type: Date },
      contacts: { type: Number, default: 0 },
      chats: { type: Number, default: 0 },
      messages: { type: Number, default: 0 },
      phase: { type: Number },
      progress: { type: Number },
      error: { type: String },
      finishedAt: { type: Date },
    },
    // The Meta Commerce catalog connected to this number's WhatsApp Business Account (Phase 8C):
    // the CRM's products marked "in the WhatsApp catalog" are synced to it.
    catalog: {
      catalogId: { type: String, trim: true },
      name: { type: String, default: '' },
      productCount: { type: Number },
      status: { type: String, enum: ['connected', 'error'] },
      statusMessage: { type: String, default: '' },
      checkedAt: { type: Date },
      catalogVisible: { type: Boolean },
      cartEnabled: { type: Boolean },
      lastSyncAt: { type: Date },
      lastSync: { sent: Number, removed: Number, failed: Number, error: String },
    },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

whatsappAccountSchema.plugin(softDelete);
whatsappAccountSchema.index({ activePhoneNumberId: 1 }, { unique: true, sparse: true });
whatsappAccountSchema.index({ webhookKey: 1 }, { unique: true });
whatsappAccountSchema.index({ organizationId: 1, deletedAt: 1, isDefault: -1 });
whatsappAccountSchema.index({ wabaId: 1 }); // the app-level webhook finds a number by its WABA

module.exports = mongoose.model('WhatsAppAccount', whatsappAccountSchema);
