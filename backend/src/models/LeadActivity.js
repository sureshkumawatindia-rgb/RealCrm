const mongoose = require('mongoose');

// Append-only timeline of a lead (created, stage changes, notes, quotations, ...).
const leadActivitySchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
    type: { type: String, required: true, trim: true },
    text: { type: String, default: '' },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorName: { type: String, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed },
    legacyIds: { type: [String], default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

leadActivitySchema.index({ organizationId: 1, leadId: 1, createdAt: -1 });
leadActivitySchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('LeadActivity', leadActivitySchema);
