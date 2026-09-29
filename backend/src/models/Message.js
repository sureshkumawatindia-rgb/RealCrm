const mongoose = require('mongoose');
const { MESSAGE_TYPES, MESSAGE_STATUSES } = require('../constants/whatsapp');

// One WhatsApp message in a conversation, in either direction. providerMessageId (Meta's
// "wamid") is unique across all organizations, so a webhook delivered twice is stored once.
const messageSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
    whatsappAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppAccount', required: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    type: { type: String, enum: MESSAGE_TYPES, required: true },
    // Text body, or the caption of a photo/video/document.
    text: { type: String, default: '' },
    media: {
      providerMediaId: { type: String },
      mimeType: { type: String },
      sha256: { type: String },
      fileName: { type: String },
      sizeBytes: { type: Number },
      storageKey: { type: String },
      voice: { type: Boolean },
    },
    location: {
      latitude: { type: Number },
      longitude: { type: Number },
      name: { type: String },
      address: { type: String },
    },
    // Button / list replies and template quick-reply buttons.
    reply: {
      id: { type: String },
      title: { type: String },
    },
    reaction: {
      providerMessageId: { type: String },
      emoji: { type: String },
    },
    template: {
      name: { type: String },
      language: { type: String },
      variables: { type: [String], default: undefined },
    },
    replyToProviderMessageId: { type: String },
    providerMessageId: { type: String },
    status: { type: String, enum: MESSAGE_STATUSES, required: true },
    sentAt: { type: Date },
    deliveredAt: { type: Date },
    readAt: { type: Date },
    failedAt: { type: Date },
    error: {
      code: { type: Number },
      title: { type: String },
      message: { type: String },
    },
    pricing: {
      billable: { type: Boolean },
      category: { type: String },
    },
    // When WhatsApp says the message was sent (inbound) — may be earlier than createdAt.
    providerTimestamp: { type: Date },
    sentByMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    // Sent by the CRM itself (e.g. an auto-reply rule), not by a person.
    automation: {
      kind: { type: String },
      ruleId: { type: mongoose.Schema.Types.ObjectId },
    },
  },
  { timestamps: true },
);

messageSchema.index({ providerMessageId: 1 }, { unique: true, sparse: true });
messageSchema.index({ organizationId: 1, conversationId: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
