const mongoose = require('mongoose');

// "Stay logged in on this browser" (login, 2026-10-08): a browser where a person finished the
// WhatsApp code step; for 30 days Google alone signs them in there. The browser keeps a random
// token in an httpOnly cookie (crm_device); only its SHA-256 is stored here.
const trustedDeviceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },
    familyId: { type: String, default: '' }, // its latest session family ("Where you're logged in")
    userAgent: { type: String, default: '' },
    expiresAt: { type: Date, required: true },
    lastUsedAt: Date,
  },
  { timestamps: true },
);

trustedDeviceSchema.index({ tokenHash: 1 }, { unique: true });
trustedDeviceSchema.index({ userId: 1 });
trustedDeviceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('TrustedDevice', trustedDeviceSchema);
