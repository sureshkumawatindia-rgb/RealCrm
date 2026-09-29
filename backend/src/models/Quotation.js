const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { QUOTATION_STATUSES, QUOTATION_TYPES } = require('../constants/crm');

// A quotation, estimate or proforma invoice (Phase 5). Amounts are integer paise computed on
// the server (utils/gst): GST on each line after its discount, CGST + SGST/UTGST within the
// seller's state, IGST otherwise. The customer and seller details are copied in, so a sent
// document keeps what it said. Editing a sent document makes a new revision; the earlier
// ones are kept in `revisions`.
const { ObjectId } = mongoose.Schema.Types;

const itemSchema = new mongoose.Schema(
  {
    productId: { type: ObjectId, ref: 'Product' },
    name: { type: String, default: '' },
    description: { type: String, default: '' },
    hsnSac: { type: String, default: '' },
    unit: { type: String, default: '' },
    quantity: { type: Number, min: 0, required: true },
    unitPricePaise: { type: Number, min: 0, required: true },
    discountType: { type: String, enum: ['amount', 'percent'], default: 'amount' },
    discountValue: { type: Number, min: 0, default: 0 }, // paise, or a percentage
    subtotalPaise: { type: Number, required: true }, // quantity × price
    discountPaise: { type: Number, default: 0 },
    taxablePaise: { type: Number, default: 0 },
    gstRatePct: { type: Number, min: 0, max: 100, default: 0 },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 }, // SGST or UTGST (supply.taxLabel)
    igstPaise: { type: Number, default: 0 },
    taxPaise: { type: Number, required: true },
    totalPaise: { type: Number, required: true },
  },
  { _id: false },
);

const partySchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    company: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    gstin: { type: String, default: '' },
    address: { type: String, default: '' },
    city: { type: String, default: '' },
    state: { type: String, default: '' },
    stateCode: { type: String, default: '' },
    postalCode: { type: String, default: '' },
  },
  { _id: false },
);

const supplySchema = new mongoose.Schema(
  {
    sellerStateCode: { type: String, default: '' },
    placeOfSupplyCode: { type: String, default: '' },
    interState: { type: Boolean, default: false },
    zeroRated: { type: Boolean, default: false }, // export / SEZ under LUT: no GST
    taxLabel: { type: String, enum: ['SGST', 'UTGST'], default: 'SGST' },
    stateAssumed: { type: Boolean, default: false }, // D30
  },
  { _id: false },
);

const rateSchema = new mongoose.Schema(
  { ratePct: Number, taxablePaise: Number, cgstPaise: Number, sgstPaise: Number, igstPaise: Number, taxPaise: Number },
  { _id: false },
);

const totalsSchema = new mongoose.Schema(
  {
    subtotalPaise: { type: Number, default: 0 },
    discountPaise: { type: Number, default: 0 },
    taxablePaise: { type: Number, default: 0 },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 },
    igstPaise: { type: Number, default: 0 },
    taxPaise: { type: Number, default: 0 },
    roundOffPaise: { type: Number, default: 0 },
    grandTotalPaise: { type: Number, default: 0 },
    byRate: { type: [rateSchema], default: [] },
  },
  { _id: false },
);

// What a revision looked like when it was replaced.
const revisionSchema = new mongoose.Schema(
  {
    revision: Number,
    status: String,
    quotationDate: Date,
    validUntil: Date,
    items: [itemSchema],
    totals: totalsSchema,
    supply: supplySchema,
    billTo: partySchema,
    terms: String,
    notes: String,
    replacedAt: { type: Date, default: Date.now },
    replacedById: { type: ObjectId, ref: 'User' },
  },
  { _id: false },
);

const quotationSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    type: { type: String, enum: QUOTATION_TYPES, default: 'Quotation' },
    number: { type: String, required: true },
    financialYear: { type: String, required: true },
    revision: { type: Number, default: 0 },
    leadId: { type: ObjectId, ref: 'Lead' },
    contactId: { type: ObjectId, ref: 'Contact' },
    // Copied from the lead (or contact), so an agent sees the quotations of the leads they own.
    ownerId: { type: ObjectId, ref: 'OrganizationMember' },
    status: { type: String, enum: QUOTATION_STATUSES, default: 'Draft' },
    quotationDate: { type: Date, default: Date.now },
    validUntil: { type: Date },
    billTo: { type: partySchema, default: () => ({}) },
    seller: {
      name: String, gstin: String, address: String, city: String, state: String, stateCode: String,
      postalCode: String, phone: String, email: String,
    },
    supply: { type: supplySchema, default: () => ({}) },
    placeOfSupplyCode: { type: String, default: '' }, // chosen by hand; '' = from the customer
    roundOff: { type: Boolean, default: true },
    items: { type: [itemSchema], default: [] },
    totals: { type: totalsSchema, default: () => ({}) },
    terms: { type: String, default: '' },
    notes: { type: String, default: '' }, // shown to the customer
    revisions: { type: [revisionSchema], default: [] },
    sentAt: { type: Date },
    sentVia: { type: String, enum: ['whatsapp', 'manual'] },
    viewedAt: { type: Date },
    lastViewedAt: { type: Date },
    viewCount: { type: Number, default: 0 },
    acceptedAt: { type: Date },
    rejectedAt: { type: Date },
    rejectedReason: { type: String, default: '' },
    expiredAt: { type: Date },
    orderId: { type: ObjectId, ref: 'Order' },
    schemaVersion: { type: Number, default: 2 },
    legacyNumber: { type: String },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

quotationSchema.plugin(softDelete);
quotationSchema.index({ organizationId: 1, number: 1 }, { unique: true });
quotationSchema.index({ organizationId: 1, leadId: 1, status: 1 });
quotationSchema.index({ organizationId: 1, contactId: 1, createdAt: -1 });
quotationSchema.index({ organizationId: 1, status: 1, validUntil: 1 });
quotationSchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('Quotation', quotationSchema);
