const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { QUOTATION_STATUSES } = require('../constants/crm');

// Phase 2 keeps the current simple quote (qty × price − discount + tax %), computed on the
// server. Phase 5 adds the CGST/SGST/IGST split, PDF, revisions and document types.
const itemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, default: '' },
    quantity: { type: Number, min: 0, required: true },
    unitPricePaise: { type: Number, min: 0, required: true },
    discountPaise: { type: Number, min: 0, default: 0 },
    taxRatePct: { type: Number, min: 0, max: 100, default: 0 },
    subtotalPaise: { type: Number, required: true },
    taxPaise: { type: Number, required: true },
    totalPaise: { type: Number, required: true },
  },
  { _id: false },
);

const quotationSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    number: { type: String, required: true },
    financialYear: { type: String, required: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
    // Copied from the lead, so an agent sees the quotations of the leads they own.
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    status: { type: String, enum: QUOTATION_STATUSES, default: 'Draft' },
    quotationDate: { type: Date, default: Date.now },
    validUntil: { type: Date },
    items: { type: [itemSchema], default: [] },
    totals: {
      subtotalPaise: { type: Number, default: 0 },
      discountPaise: { type: Number, default: 0 },
      taxPaise: { type: Number, default: 0 },
      grandTotalPaise: { type: Number, default: 0 },
    },
    legacyNumber: { type: String },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

quotationSchema.plugin(softDelete);
quotationSchema.index({ organizationId: 1, number: 1 }, { unique: true });
quotationSchema.index({ organizationId: 1, leadId: 1, status: 1 });
quotationSchema.index({ organizationId: 1, contactId: 1, createdAt: -1 });
quotationSchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('Quotation', quotationSchema);
