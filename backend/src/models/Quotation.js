const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { QUOTATION_STATUSES, QUOTATION_TYPES } = require('../constants/crm');
const { APPROVAL_STATES, REASON_KINDS } = require('../constants/approvals');

// A quotation, estimate or proforma invoice (Phase 5). Amounts are integer paise computed on
// the server (utils/gst): GST on each line after its discount, CGST + SGST/UTGST within the
// seller's state, IGST otherwise. The customer and seller details are copied in, so a sent
// document keeps what it said. Editing a sent document makes a new revision; the earlier
// ones are kept in `revisions`.
const { ObjectId } = mongoose.Schema.Types;

const { itemSchema, partySchema, supplySchema, totalsSchema, sellerSchema } = require('./schemas/documentParts');

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
    seller: { type: sellerSchema, default: () => ({}) },
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
    // Approval (D77, services/approvalService.js): asked for when a draft crosses a rule's limit.
    // It counts only while the lines and totals still have its fingerprint.
    approval: {
      type: new mongoose.Schema(
        {
          state: { type: String, enum: APPROVAL_STATES },
          reasons: {
            type: [new mongoose.Schema({ ruleId: ObjectId, ruleName: String, kind: { type: String, enum: REASON_KINDS }, value: Number, limit: Number }, { _id: false })],
            default: [],
          },
          fingerprint: { type: String },
          requestedById: { type: ObjectId, ref: 'OrganizationMember' },
          requestedAt: { type: Date },
          decidedById: { type: ObjectId, ref: 'OrganizationMember' },
          decidedAt: { type: Date },
          comment: { type: String, default: '' },
        },
        { _id: false },
      ),
      default: undefined,
    },
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
quotationSchema.index({ organizationId: 1, 'approval.state': 1, createdAt: -1 });
// The plan's quotations this month (Phase 10).
quotationSchema.index({ organizationId: 1, createdAt: -1 });

module.exports = mongoose.model('Quotation', quotationSchema);
