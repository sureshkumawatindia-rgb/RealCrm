const mongoose = require('mongoose');

// One run of "Move my browser data to server" (preview or commit) and its report.
const importSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    source: { type: String, enum: ['localstorage'], default: 'localstorage' },
    dryRun: { type: Boolean, required: true },
    status: { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
    report: { type: mongoose.Schema.Types.Mixed },
    error: { type: String },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

importSchema.index({ organizationId: 1, createdAt: -1 });

module.exports = mongoose.model('Import', importSchema);
