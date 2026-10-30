const mongoose = require('mongoose');

// A saved answer for the inbox: typing "/<shortcut>" in the composer inserts the body.
// Shared by the whole organization.
const quickReplySchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    shortcut: { type: String, required: true, trim: true, lowercase: true },
    title: { type: String, trim: true, default: '' },
    body: { type: String, required: true },
    // D103: a photo, video or document from Documents, sent with the text (as its caption).
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
    createdByMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
  },
  { timestamps: true },
);

quickReplySchema.index({ organizationId: 1, shortcut: 1 }, { unique: true });

module.exports = mongoose.model('QuickReply', quickReplySchema);
