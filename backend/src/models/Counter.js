const mongoose = require('mongoose');

// Per-organization sequences (ticket numbers, quotation numbers per financial year, ...).
const counterSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true },
);

counterSchema.index({ organizationId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Counter', counterSchema);
