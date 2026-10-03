const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { ORDER_STAGES } = require('../constants/crm');
const { itemSchema, partySchema, supplySchema, totalsSchema, sellerSchema } = require('./schemas/documentParts');

// An order made from an accepted quotation (Phase 5): its lines, totals and parties are copied
// from the quotation, then it moves Received → Processing → Dispatched → Delivered → Payment
// Collected (or Cancelled, with a reason). Each move is kept in `history`. With "reduce stock
// on dispatch" (Settings → Billing) the products' stock goes down once, and comes back if the
// order is cancelled or moved back before dispatch.
const { ObjectId } = mongoose.Schema.Types;

const historySchema = new mongoose.Schema(
  {
    stage: String,
    from: String,
    at: { type: Date, default: Date.now },
    byUserId: { type: ObjectId, ref: 'User' },
    byName: { type: String, default: '' },
    note: { type: String, default: '' },
    notified: { type: Boolean, default: false }, // a WhatsApp update went to the customer
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    number: { type: String, required: true },
    financialYear: { type: String, required: true },
    quotationId: { type: ObjectId, ref: 'Quotation' },
    quotationNumber: { type: String, default: '' },
    leadId: { type: ObjectId, ref: 'Lead' },
    contactId: { type: ObjectId, ref: 'Contact' },
    ownerId: { type: ObjectId, ref: 'OrganizationMember' },
    stage: { type: String, enum: ORDER_STAGES, default: 'Received' },
    orderDate: { type: Date, default: Date.now },
    billTo: { type: partySchema, default: () => ({}) },
    seller: { type: sellerSchema, default: () => ({}) },
    supply: { type: supplySchema, default: () => ({}) },
    items: { type: [itemSchema], default: [] },
    totals: { type: totalsSchema, default: () => ({}) },
    dispatch: {
      transporter: { type: String, default: '' },
      lrNumber: { type: String, default: '' }, // lorry receipt / docket / AWB number
      vehicleNumber: { type: String, default: '' },
      dispatchedAt: { type: Date },
      expectedDeliveryDate: { type: Date },
    },
    deliveredAt: { type: Date },
    paidAt: { type: Date },
    cancelledAt: { type: Date },
    cancelReason: { type: String, default: '' },
    notes: { type: String, default: '' },
    stockReduced: { type: Boolean, default: false },
    // What was taken off each product's stock (never below 0), so it can be put back exactly.
    stockMoves: { type: [{ _id: false, productId: { type: ObjectId, ref: 'Product' }, quantity: Number }], default: [] },
    history: { type: [historySchema], default: [] },
    createdById: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

orderSchema.plugin(softDelete);
orderSchema.index({ organizationId: 1, number: 1 }, { unique: true });
orderSchema.index({ organizationId: 1, stage: 1, createdAt: -1 });
orderSchema.index({ organizationId: 1, contactId: 1, createdAt: -1 });
orderSchema.index({ organizationId: 1, quotationId: 1 }, { unique: true, partialFilterExpression: { quotationId: { $type: 'objectId' } } });

module.exports = mongoose.model('Order', orderSchema);
