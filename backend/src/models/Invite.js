const mongoose = require('mongoose');
const { INVITABLE_ROLES, MODULES } = require('../constants/permissions');

const inviteSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: INVITABLE_ROLES, required: true },
    modules: { type: [{ type: String, enum: MODULES }], default: [] },
    permissions: { type: [String], default: [] },
    // Only the SHA-256 of the invite token is stored; the link is shown once to the inviter.
    tokenHash: { type: String },
    status: { type: String, enum: ['pending', 'accepted', 'revoked'], default: 'pending' },
    expiresAt: { type: Date, required: true },
    invitedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    acceptedAt: { type: Date },
    acceptedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// One invite document per (organization, email); inviting again refreshes it.
inviteSchema.index({ organizationId: 1, email: 1 }, { unique: true });
inviteSchema.index({ tokenHash: 1 }, { unique: true, sparse: true });
inviteSchema.index({ email: 1, status: 1 });

module.exports = mongoose.model('Invite', inviteSchema);
