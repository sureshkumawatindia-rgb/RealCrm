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
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

whatsappAccountSchema.plugin(softDelete);
whatsappAccountSchema.index({ activePhoneNumberId: 1 }, { unique: true, sparse: true });
whatsappAccountSchema.index({ webhookKey: 1 }, { unique: true });
whatsappAccountSchema.index({ organizationId: 1, deletedAt: 1, isDefault: -1 });

module.exports = mongoose.model('WhatsAppAccount', whatsappAccountSchema);
