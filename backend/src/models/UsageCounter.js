const mongoose = require('mongoose');

// A count kept as it happens, for what leaves no record of its own (Phase 3A, D80): today the
// public API's calls. One row per company, metric and India month, raised with one atomic $inc,
// so calls at the same moment are never lost. Kept 400 days after the month.
const usageCounterSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    metric: { type: String, required: true },
    period: { type: String, required: true }, // YYYY-MM, India
    count: { type: Number, default: 0 },
    expireAt: { type: Date, required: true },
  },
  { timestamps: true },
);

usageCounterSchema.index({ organizationId: 1, metric: 1, period: 1 }, { unique: true });
usageCounterSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('UsageCounter', usageCounterSchema);
