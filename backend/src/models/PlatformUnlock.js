const mongoose = require('mongoose');

// The platform admin page is open for one login (its session family, D104) for 30 minutes after
// the admin entered a code from their authenticator app. Removed when it runs out.
const platformUnlockSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    familyId: { type: String, required: true },
    until: { type: Date, required: true },
  },
  { timestamps: true },
);

platformUnlockSchema.index({ userId: 1, familyId: 1 }, { unique: true });
platformUnlockSchema.index({ until: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PlatformUnlock', platformUnlockSchema);
