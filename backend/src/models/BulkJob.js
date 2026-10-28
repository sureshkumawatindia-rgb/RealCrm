const mongoose = require('mongoose');

// A bulk action on more than 200 leads or customers (D100), done row by row in the background
// ("bulk.run" jobs) for the member who started it, with its progress and report. Up to 5,000
// rows; `position` is how far it got, so a retried job carries on where it stopped.
const { ObjectId, Mixed } = mongoose.Schema.Types;

const bulkJobSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    memberId: { type: ObjectId, ref: 'OrganizationMember', required: true },
    object: { type: String, enum: ['lead', 'contact'], required: true },
    action: { type: String, required: true },
    params: { type: Mixed, default: () => ({}) },
    runAutomations: { type: Boolean, default: false },
    ids: { type: [ObjectId], default: [] },
    status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued' },
    position: { type: Number, default: 0 },
    done: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    // Why rows were left: { PRIVATE: 20, NOT_FOUND: 1 }; `failed` keeps the first 500 of them.
    reasons: { type: Mixed, default: () => ({}) },
    failed: { type: [{ _id: false, id: String, code: String, message: String }], default: [] },
    error: { type: String },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true },
);

bulkJobSchema.index({ organizationId: 1, memberId: 1, createdAt: -1 });
// Reports are kept 30 days.
bulkJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('BulkJob', bulkJobSchema);
