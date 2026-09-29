const mongoose = require('mongoose');

// A background job (D10: a small queue in MongoDB, no Redis). jobs/queue.js claims due jobs
// atomically, so several server processes can share the collection without running a job twice.
// liveKey is set while a job with a uniqueKey is queued or running: one live job per key
// (a lead source's poll, a lead's auto-reply).
const jobSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
    uniqueKey: { type: String },
    liveKey: { type: String },
    runAt: { type: Date, required: true },
    // Recurring jobs go back to "queued" after each run instead of finishing.
    repeatEveryMs: { type: Number },
    status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    lockedBy: { type: String },
    lockUntil: { type: Date },
    lastRunAt: { type: Date },
    lastError: { type: String, default: '' },
    finishedAt: { type: Date },
  },
  { timestamps: true },
);

jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ liveKey: 1 }, { unique: true, sparse: true });
jobSchema.index({ organizationId: 1, name: 1, createdAt: -1 });
// Finished jobs are kept a week for troubleshooting.
jobSchema.index({ finishedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = mongoose.model('Job', jobSchema);
