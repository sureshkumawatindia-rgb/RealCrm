const mongoose = require('mongoose');

// One document per refresh token. Rotation revokes the old document and creates a new one in
// the same family; presenting a revoked token again revokes the whole family (reuse detection).
const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    familyId: { type: String, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, enum: ['rotated', 'logout', 'reuse', 'removed'] },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    // For Settings → Your Profile → "Where you're logged in" (2026-10-08), carried along when
    // the token rotates: how this browser logged in, and when.
    loginMethod: { type: String, default: '' },
    familyStartedAt: Date,
  },
  { timestamps: true },
);

sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ familyId: 1 });
sessionSchema.index({ userId: 1, organizationId: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Session', sessionSchema);
