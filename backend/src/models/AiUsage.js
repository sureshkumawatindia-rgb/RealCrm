const mongoose = require('mongoose');
const { AI_FEATURES, AI_OUTCOMES } = require('../constants/ai');

// One call to the AI assistant (Phase 10D): what for, which model, the tokens and the
// estimated cost (millionths of a US dollar), and what came of it. The monthly budget and the
// usage in Settings → AI assistant are counted from these. Kept 13 months.
const aiUsageSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    feature: { type: String, enum: AI_FEATURES, required: true },
    model: { type: String, default: '' },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 },
    cacheWriteTokens: { type: Number, default: 0 },
    costMicros: { type: Number, default: 0 },
    outcome: { type: String, enum: AI_OUTCOMES, required: true },
    reason: { type: String, default: '' },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    durationMs: Number,
  },
  { timestamps: true },
);

aiUsageSchema.index({ organizationId: 1, createdAt: -1 });
aiUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

module.exports = mongoose.model('AiUsage', aiUsageSchema);
