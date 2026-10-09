const mongoose = require('mongoose');

// A chat resolved (closed) by a teammate (D61): the resolution rate and time on the team reports.
// memberId: the chat's assignee when it was closed, else whoever closed it; seconds: from when the
// chat was (re)opened to the close.
const chatResolutionSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    closedById: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    openedAt: { type: Date },
    closedAt: { type: Date, required: true },
    seconds: { type: Number },
  },
  { timestamps: true },
);

chatResolutionSchema.index({ organizationId: 1, closedAt: -1 });

module.exports = mongoose.model('ChatResolution', chatResolutionSchema);
