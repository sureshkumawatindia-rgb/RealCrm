const mongoose = require('mongoose');
const { CONVERSATION_STATUSES } = require('../constants/whatsapp');
const { CHAT_CHANNELS } = require('../constants/social');

// One WhatsApp chat between a contact and one of the organization's numbers — or (G8, D112) an
// Instagram or Messenger chat with one of its connected Pages' accounts.
// lastInboundAt drives the 24-hour customer service window.
const conversationSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
    // An Instagram or Messenger chat keeps its SocialAccount's id here too, so a customer has one
    // chat per account, as on a WhatsApp number (the unique index below), and every WhatsApp-only
    // action finds no WhatsApp number for it.
    whatsappAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppAccount', required: true },
    // G8 (D112): the channel (none = WhatsApp); for Instagram and Messenger the account, the
    // customer's Page- or Instagram-scoped id (whom replies go to) and their Instagram @username.
    channel: { type: String, enum: CHAT_CHANNELS },
    socialAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialAccount' },
    socialUserId: { type: String },
    socialUsername: { type: String },
    assigneeId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    status: { type: String, enum: CONVERSATION_STATUSES, default: 'open' },
    lastInboundAt: { type: Date },
    lastMessageAt: { type: Date },
    lastMessagePreview: { type: String, default: '' },
    lastMessageDirection: { type: String, enum: ['in', 'out', ''], default: '' },
    // 'history' while the newest message is one imported from a WhatsApp Business app number
    // (D60): time-based automations ("no reply for N hours") leave such chats alone.
    lastMessageOrigin: { type: String, default: '' },
    unreadCount: { type: Number, min: 0, default: 0 },
    // A private number (D61): only owners see it (and its leads and chats).
    private: { type: Boolean },
    // When the chat was last opened (new, or reopened by the customer): resolution time (D61).
    openedAt: { type: Date },
    tags: { type: [String], default: [] },
    // D102: where the customer's latest enquiry came from — a Click-to-WhatsApp ad (its headline,
    // link and picture) or the website's WhatsApp button (the page). The Inbox shows it.
    cameFrom: {
      kind: { type: String, enum: ['ad', 'widget'] },
      headline: { type: String },
      sourceId: { type: String },
      sourceUrl: { type: String },
      mediaUrl: { type: String },
      page: { type: String },
      at: { type: Date },
    },
    // CP3: pinned by each member for themselves; archived for the whole company (a new message
    // from the customer brings the chat back).
    pinnedBy: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
    archivedAt: { type: Date },
    archivedById: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    // D103: the customer is blocked (a copy of Contact.blocked.at): the chat leaves the lists for
    // the "Blocked" one.
    blockedAt: { type: Date },
    // The customer's message the last read receipt was sent for (blue ticks once per message).
    readReceiptFor: { type: String },
    // The FAQ bot in this chat (Phase 6C): handedOffAt = the customer asked for a person (or a
    // teammate paused the bot); the bot stays quiet until the chat is closed or it is turned on.
    // The AI assistant's answers here (Phase 10D): when it last answered, and when it passed the
    // chat to a person (it then stays quiet for a day, or until a teammate writes).
    ai: {
      answeredAt: { type: Date },
      handedOffAt: { type: Date },
      handoffReason: { type: String },
    },
    bot: {
      handedOffAt: { type: Date },
      handoffReason: { type: String },
      greetedAt: { type: Date },
      awayAt: { type: Date },
      lastAnsweredAt: { type: Date },
    },
    // G7 (D111): may the business call this customer on WhatsApp? requested = we asked (and when);
    // granted = they allowed it (for good, or until expiresAt), by answering our request or — with
    // "customers who call can be called back" — by calling us; rejected = they said no.
    callPermission: {
      status: { type: String, enum: ['requested', 'granted', 'rejected'] },
      permanent: { type: Boolean },
      expiresAt: { type: Date },
      requestedAt: { type: Date },
      answeredAt: { type: Date },
      source: { type: String, enum: ['reply', 'call'] },
    },
  },
  { timestamps: true },
);

conversationSchema.index({ organizationId: 1, contactId: 1, whatsappAccountId: 1 }, { unique: true });
// G8: one chat per Instagram or Messenger customer of an account (the webhook finds it by them).
conversationSchema.index({ organizationId: 1, socialAccountId: 1, socialUserId: 1 }, { unique: true, partialFilterExpression: { socialUserId: { $type: 'string' } } });
conversationSchema.index({ organizationId: 1, assigneeId: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index({ organizationId: 1, status: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
