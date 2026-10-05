const mongoose = require('mongoose');

// A WhatsApp broadcast (Phase 7): one approved template, filled in per customer, sent to a
// segment — now or at a set time, in small batches within Meta's daily limit. Each customer is a
// BroadcastRecipient with their own status. Counts are worked out from the recipients.
const { Mixed, ObjectId } = mongoose.Schema.Types;
const BROADCAST_STATUSES = ['draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled', 'failed'];

const broadcastSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: BROADCAST_STATUSES, default: 'draft' },
    templateId: { type: ObjectId, ref: 'MessageTemplate', required: true },
    templateName: { type: String, default: '' },
    templateLanguage: { type: String, default: '' },
    category: { type: String, default: '' }, // MARKETING | UTILITY (from the template)
    whatsappAccountId: { type: ObjectId, ref: 'WhatsAppAccount' },
    variables: { type: Mixed, default: () => ({}) }, // { header, body, buttons }: CRM values or "text:…"
    segmentId: { type: ObjectId, ref: 'Segment', required: true },
    segmentName: { type: String, default: '' },
    scheduledAt: { type: Date },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    // Meta's daily limit was reached: the rest goes after this time.
    waitUntil: { type: Date },
    batches: { type: Number, default: 0 },
    estimate: { type: Mixed }, // the cost estimate when it was started
    error: { type: String, default: '' },
    createdById: { type: ObjectId, ref: 'User' },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true },
);

broadcastSchema.index({ organizationId: 1, createdAt: -1 });
broadcastSchema.index({ organizationId: 1, startedAt: 1 });

module.exports = mongoose.model('Broadcast', broadcastSchema);
module.exports.BROADCAST_STATUSES = BROADCAST_STATUSES;
