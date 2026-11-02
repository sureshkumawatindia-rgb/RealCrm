const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { SOCIAL_CHANNELS, SOCIAL_PROVIDERS } = require('../constants/social');

// A Facebook Page's Messenger, or the Instagram professional account linked to the Page (G8,
// D112), connected in Settings → WhatsApp → "Instagram and Messenger" by an owner or admin with
// Facebook Login. Both are answered with the Page's token (secretBox, never sent to the browser).
// Meta's webhooks (objects page and instagram) find the account by externalId: the Page's id, or
// the Instagram account's id. activeExternalId is set while it is connected, so a Page or an
// Instagram account belongs to one company at a time.
const socialAccountSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    channel: { type: String, enum: SOCIAL_CHANNELS, required: true },
    provider: { type: String, enum: SOCIAL_PROVIDERS, default: 'meta' },
    externalId: { type: String, required: true, trim: true },
    activeExternalId: { type: String },
    pageId: { type: String, required: true, trim: true }, // the Page that sends
    name: { type: String, trim: true, default: '' }, // the Page's or the Instagram account's name
    username: { type: String, trim: true, default: '' }, // Instagram: the @username
    accessTokenEnc: { type: String },
    accessTokenLast4: { type: String, default: '' },
    status: { type: String, enum: ['connected', 'error', 'disconnected'], default: 'connected' },
    statusMessage: { type: String, default: '' },
    connectedAt: { type: Date },
    lastWebhookAt: { type: Date },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

socialAccountSchema.plugin(softDelete);
socialAccountSchema.index({ channel: 1, activeExternalId: 1 }, { unique: true, partialFilterExpression: { activeExternalId: { $type: 'string' } } });
socialAccountSchema.index({ organizationId: 1, deletedAt: 1 });

module.exports = mongoose.model('SocialAccount', socialAccountSchema);
