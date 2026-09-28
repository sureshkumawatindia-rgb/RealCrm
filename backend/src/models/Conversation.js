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
    unreadCount: { type: Number, min: 0, default: 0 },
    tags: { type: [String], default: [] },
  },
  { timestamps: true },
);

conversationSchema.index({ organizationId: 1, contactId: 1, whatsappAccountId: 1 }, { unique: true });
conversationSchema.index({ organizationId: 1, assigneeId: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index({ organizationId: 1, status: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
