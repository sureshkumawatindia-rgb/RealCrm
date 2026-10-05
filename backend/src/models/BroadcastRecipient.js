const mongoose = require('mongoose');

// One customer in a broadcast (Phase 7): pending until sent, then the WhatsApp statuses as they
// come back (delivered, read), replied when the customer writes back within 7 days, or failed /
// skipped with the reason. The timestamps only move forward.
const { ObjectId } = mongoose.Schema.Types;
const RECIPIENT_STATUSES = ['pending', 'sent', 'delivered', 'read', 'replied', 'failed', 'skipped'];

const recipientSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    broadcastId: { type: ObjectId, ref: 'Broadcast', required: true },
    contactId: { type: ObjectId, ref: 'Contact', required: true },
    name: { type: String, default: '' },
    phoneE164: { type: String, default: '' },
    status: { type: String, enum: RECIPIENT_STATUSES, default: 'pending' },
    reason: { type: String, default: '' }, // why skipped or failed
    messageId: { type: ObjectId, ref: 'Message' },
    conversationId: { type: ObjectId, ref: 'Conversation' },
    sentAt: { type: Date },
    deliveredAt: { type: Date },
    readAt: { type: Date },
    repliedAt: { type: Date },
    failedAt: { type: Date },
  },
  { timestamps: true },
);

recipientSchema.index({ broadcastId: 1, contactId: 1 }, { unique: true });
recipientSchema.index({ broadcastId: 1, status: 1 });
recipientSchema.index({ messageId: 1 }, { sparse: true });
recipientSchema.index({ organizationId: 1, contactId: 1, sentAt: -1 });

module.exports = mongoose.model('BroadcastRecipient', recipientSchema);
module.exports.RECIPIENT_STATUSES = RECIPIENT_STATUSES;
