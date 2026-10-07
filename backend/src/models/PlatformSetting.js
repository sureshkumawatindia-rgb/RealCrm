const mongoose = require('mongoose');

// Settings of the platform itself, not of one organization (Phase 10E): e.g. the web push VAPID
// key pair made on first use (its private key encrypted with secretBox).
const platformSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);

platformSettingSchema.index({ key: 1 }, { unique: true });

module.exports = mongoose.model('PlatformSetting', platformSettingSchema);
