const mongoose = require('mongoose');

// How an outside service answered the CRM, minute by minute (Phase 9, D151): calls answered, and
// calls that failed because of the service (no answer, 5xx, its own "temporarily unavailable").
// A company's own mistakes (a wrong key, a bad number) count as answered. Kept 3 days.
const serviceHealthSchema = new mongoose.Schema({
  service: { type: String, required: true },
  minute: { type: Date, required: true },
  ok: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  lastError: { type: String, default: '' },
});

serviceHealthSchema.index({ service: 1, minute: 1 }, { unique: true });
serviceHealthSchema.index({ minute: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

module.exports = mongoose.model('ServiceHealth', serviceHealthSchema);
