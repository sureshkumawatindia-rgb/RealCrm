const mongoose = require('mongoose');

// A customer's request about their own data, and what was done (Phase 8, D120; India's DPDP Act
// 2023: s. 11 a copy of their data, s. 12 erasure). The company's proof that it answered, and how
// soon: when the customer asked, when it was done and by whom. After an erasure no name is kept
// here (contactName is cleared for that customer's earlier requests too).
const PRIVACY_REQUEST_TYPES = Object.freeze(['access', 'erasure']);

const privacyRequestSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    type: { type: String, enum: PRIVACY_REQUEST_TYPES, required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
    contactName: { type: String, default: '' },
    askedAt: { type: Date, required: true },
    doneAt: { type: Date, required: true },
    byMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    byName: { type: String, default: '' },
    format: { type: String, enum: ['html', 'json'] }, // access: the file given
    // erasure: how many records went, were made anonymous or were kept by law, and until when.
    summary: { type: mongoose.Schema.Types.Mixed },
    keptUntil: { type: Date },
  },
  { timestamps: true },
);

privacyRequestSchema.index({ organizationId: 1, doneAt: -1 });
privacyRequestSchema.index({ organizationId: 1, contactId: 1 });

module.exports = mongoose.model('PrivacyRequest', privacyRequestSchema);
module.exports.PRIVACY_REQUEST_TYPES = PRIVACY_REQUEST_TYPES;
