const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { LEAD_SOURCES, CONTACT_LIFECYCLES, CONTACT_STATUSES } = require('../constants/crm');

// One person or business the organization talks to (D3). Leads, quotations, tickets and
// conversations reference a contact. The E.164 phone is unique per organization when present.
const contactSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    phoneE164: { type: String },
    company: { type: String, trim: true, default: '' },
    gstin: { type: String, trim: true, uppercase: true, default: '' },
    stateCode: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    address: { type: String, trim: true, default: '' },
    tags: { type: [String], default: [] },
    source: { type: String, enum: LEAD_SOURCES, default: 'Manual' },
    sourceRef: { type: String },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    lifecycle: { type: String, enum: CONTACT_LIFECYCLES, default: 'lead' },
    // A private number (D61): only owners see it (and its leads and chats).
    private: { type: Boolean },
    status: { type: String, enum: CONTACT_STATUSES, default: 'Active' },
    productIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }], default: [] },
    notes: { type: String, default: '' },
    consent: {
      marketing: { type: String, enum: ['unknown', 'opted_in', 'opted_out'], default: 'unknown' },
      changedAt: { type: Date },
      method: { type: String },
    },
    becameCustomerAt: { type: Date },
    // How they first found the company (D79): set by their first tracked enquiry, never changed.
    firstTouch: { channel: String, source: String, medium: String, campaign: String, adId: String, ad: String, at: Date },
    // Asked not to get SMS (D88): when and how (by hand, the API, a STOP reply).
    smsOptOut: { at: { type: Date }, method: { type: String } },
    // The last call with the customer (D85), for lists and follow-ups.
    lastContactedAt: { type: Date },
    // The company's own fields (D73): { key: value }, checked by services/customFieldService.js.
    customFields: { type: mongoose.Schema.Types.Mixed },
    legacyIds: { type: [String], default: undefined },
    // Merged into another customer (D100): this one is deleted, everything it had moved there.
    mergedIntoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

contactSchema.plugin(softDelete);
// Deleting a contact clears phoneE164 (see contactService), so the number can be used again.
contactSchema.index(
  { organizationId: 1, phoneE164: 1 },
  { unique: true, partialFilterExpression: { phoneE164: { $type: 'string' } } },
);
contactSchema.index({ organizationId: 1, deletedAt: 1, lifecycle: 1, createdAt: -1 });
contactSchema.index({ organizationId: 1, ownerId: 1, lifecycle: 1 });
contactSchema.index({ organizationId: 1, email: 1 });
contactSchema.index({ organizationId: 1, tags: 1 });
contactSchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('Contact', contactSchema);
