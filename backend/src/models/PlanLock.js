const mongoose = require('mongoose');

// A short hold on one kind of counted thing of one company while one is added (Phase 3B, D81):
// _id "<organizationId>:<contacts|team|templates|…>". The hold ends when its holder lets go, or
// by itself at expireAt if the server stopped first (the TTL index tidies up after that).
const planLockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    holder: { type: String, required: true },
    expireAt: { type: Date, required: true },
  },
  { versionKey: false },
);

planLockSchema.index({ expireAt: 1 }, { expireAfterSeconds: 60 });

module.exports = mongoose.model('PlanLock', planLockSchema);
