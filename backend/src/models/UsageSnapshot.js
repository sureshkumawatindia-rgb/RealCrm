const mongoose = require('mongoose');

// What a company used on one day (Phase 3A, D80): every meter as the hourly job counted it the
// first time it ran that day (India time). Written once and never edited, so a later question
// about usage can be checked against it; kept 400 days.
const usageSnapshotSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    day: { type: String, required: true }, // YYYY-MM-DD, India
    plan: { type: String, default: '' },
    meters: [{
      _id: false,
      metric: { type: String, required: true },
      used: { type: Number, default: 0 },
      limit: { type: Number, default: null }, // null: no limit that day
    }],
    expireAt: { type: Date, required: true },
  },
  { timestamps: true },
);

usageSnapshotSchema.index({ organizationId: 1, day: 1 }, { unique: true });
usageSnapshotSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('UsageSnapshot', usageSnapshotSchema);
