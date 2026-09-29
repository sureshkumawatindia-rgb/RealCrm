const mongoose = require('mongoose');
const { LEAD_SOURCES } = require('../constants/crm');
const { INTAKE_OUTCOMES } = require('../constants/leadSources');

// Every enquiry that reached the CRM from a lead source, with its raw payload (size-capped) and
// what became of it. The unique (organization, source, sourceRef) index is the dedupe: the same
// IndiaMART query or Facebook lead is only ever taken once.
const leadIntakeSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    source: { type: String, enum: LEAD_SOURCES, required: true },
    sourceRef: { type: String, required: true },
    connectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'LeadSourceConnection' },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    outcome: { type: String, enum: INTAKE_OUTCOMES, default: 'processing' },
    reason: { type: String, default: '' },
    summary: { type: String, default: '' },
    raw: { type: mongoose.Schema.Types.Mixed },
    receivedAt: { type: Date, default: Date.now },
    processedAt: { type: Date },
  },
  { timestamps: true },
);

leadIntakeSchema.index({ organizationId: 1, source: 1, sourceRef: 1 }, { unique: true });
leadIntakeSchema.index({ organizationId: 1, connectionId: 1, createdAt: -1 });

module.exports = mongoose.model('LeadIntake', leadIntakeSchema);
