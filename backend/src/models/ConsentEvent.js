const mongoose = require('mongoose');

// One change of a customer's consent to marketing messages (Phase 2, D79): from what to what,
// how (the customer form, a STOP/START reply, an import, the API, the website form) and by whom.
// Contact.consent keeps only the current state; these keep the history, never edited.
const CONSENT_STATES = Object.freeze(['unknown', 'opted_in', 'opted_out']);
const CONSENT_METHODS = Object.freeze(['manual', 'whatsapp_reply', 'import', 'api', 'website_form']);

const consentEventSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
    channel: { type: String, enum: ['whatsapp'], default: 'whatsapp' },
    from: { type: String, enum: CONSENT_STATES, required: true },
    to: { type: String, enum: CONSENT_STATES, required: true },
    method: { type: String, enum: CONSENT_METHODS, required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    actorName: { type: String, default: '' }, // a teammate, an API key, "Customer"
    detail: { type: String, default: '' }, // e.g. the web page of the form
    at: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

consentEventSchema.index({ organizationId: 1, contactId: 1, at: -1 });

module.exports = mongoose.model('ConsentEvent', consentEventSchema);
module.exports.CONSENT_METHODS = CONSENT_METHODS;
