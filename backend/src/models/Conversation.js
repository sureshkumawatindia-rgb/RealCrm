const mongoose = require('mongoose');
const { CONVERSATION_STATUSES } = require('../constants/whatsapp');

// One WhatsApp chat between a contact and one of the organization's numbers.
// lastInboundAt drives the 24-hour customer service window.
const conversationSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
    whatsappAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppAccount', required: true },
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
  },
  { timestamps: true },
);

conversationSchema.index({ organizationId: 1, contactId: 1, whatsappAccountId: 1 }, { unique: true });
conversationSchema.index({ organizationId: 1, assigneeId: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index({ organizationId: 1, status: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
