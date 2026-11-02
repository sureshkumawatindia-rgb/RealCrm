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
    // D102: the Click-to-WhatsApp ad the customer wrote from (the webhook's referral, without
    // the click id, which is kept on the Touchpoint).
    referral: {
      sourceType: { type: String },
      sourceId: { type: String },
      sourceUrl: { type: String },
      headline: { type: String },
      body: { type: String },
      mediaType: { type: String },
      mediaUrl: { type: String },
      welcomeText: { type: String },
    },
    // The reactions on this message (CP3): the customer's (from a reaction webhook) and ours.
    reactions: {
      customer: { type: String },
      business: { type: String },
    },
    // Buttons or a list the CRM sent (Phase 6C bot); the customer's choice comes back as reply.
    // Products from the WhatsApp catalog (Phase 8C): kind product (one) or product_list.
    interactive: {
      // call_permission: asking the customer for permission to call them on WhatsApp (G7, D111).
      kind: { type: String, enum: ['button', 'list', 'product', 'product_list', 'flow', 'call_permission'] },
      listButton: { type: String },
      footer: { type: String },
      options: {
        type: [{ _id: false, id: String, title: String, description: String }],
        default: undefined,
      },
      products: {
        type: [{ _id: false, productId: mongoose.Schema.Types.ObjectId, retailerId: String, name: String }],
        default: undefined,
      },
    },
    // A cart the customer sent from the WhatsApp catalog (type "order"), and the CRM order made from it.
    order: {
      catalogId: { type: String },
      text: { type: String },
      items: {
        type: [{ _id: false, retailerId: String, quantity: Number, itemPricePaise: Number, currency: String }],
        default: undefined,
      },
      orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    },
    // G6 (D110): a WhatsApp form — the one sent (formId, its name, token: the flow_token Meta gives
    // back with the answers), or the customer's answers to it (values as Meta sent them, answers
    // as the chat shows them, the lead or order they went into, done once they were used).
    form: {
      formId: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppForm' },
      name: { type: String },
      token: { type: String },
      values: { type: mongoose.Schema.Types.Mixed },
      answers: { type: [{ _id: false, label: String, value: String }], default: undefined },
      leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
      orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
      done: { type: Boolean },
    },
    // G7 (D111): a WhatsApp call's line in the chat (type "call"): the call, how it went and how long.
    call: {
      callId: { type: mongoose.Schema.Types.ObjectId, ref: 'Call' },
      status: { type: String },
      durationSec: { type: Number },
    },
    // G7: the customer's answer to our request to call them (Meta's call_permission_reply):
    // allowed or not, for good or until expiresAt.
    callPermission: {
      response: { type: String, enum: ['accept', 'reject'] },
      permanent: { type: Boolean },
      expiresAt: { type: Date },
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
    playedAt: { type: Date },
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
    // Not written in the CRM (a WhatsApp Business app number, D60): history = imported from the
    // last 6 months when the number was connected; phone = sent from the app on the phone.
    origin: { type: String, enum: ['history', 'phone'] },
    // A message of a private number (D61): only owners see it; reports leave it out.
    private: { type: Boolean },
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
// Reports (Phase 9): messages of a date range.
messageSchema.index({ organizationId: 1, createdAt: -1 });
// G6 (D110): the form a customer's answers belong to, by the token sent with it.
messageSchema.index({ organizationId: 1, 'form.token': 1 }, { partialFilterExpression: { 'form.token': { $exists: true } } });

module.exports = mongoose.model('Message', messageSchema);
