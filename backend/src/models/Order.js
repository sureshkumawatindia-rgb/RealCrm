const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { ORDER_STAGES } = require('../constants/crm');
const { itemSchema, partySchema, supplySchema, totalsSchema, sellerSchema } = require('./schemas/documentParts');

// An order made from an accepted quotation (Phase 5): its lines, totals and parties are copied
// from the quotation, then it moves Received → Processing → Dispatched → Delivered → Payment
// Collected (or Cancelled, with a reason). Each move is kept in `history`. With "reduce stock
// on dispatch" (Settings → Billing) the products' stock goes down once, and comes back if the
// order is cancelled or moved back before dispatch. Payments (Phase 8) are kept in `payments`:
// paid in full, a Delivered order moves on to Payment Collected by itself.
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

const paymentSchema = new mongoose.Schema({
  source: { type: String, enum: ['link', 'manual'], required: true },
  amountPaise: { type: Number, required: true },
  method: { type: String, default: '' },
  reference: { type: String, default: '' }, // UTR / cheque number / note
  paidAt: { type: Date, default: Date.now },
  paymentLinkId: { type: ObjectId, ref: 'PaymentLink' },
  provider: { type: String, default: '' },
  providerPaymentId: { type: String },
  recordedById: { type: ObjectId, ref: 'User' },
  recordedByName: { type: String, default: '' },
});

const orderSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    number: { type: String, required: true },
    financialYear: { type: String, required: true },
    quotationId: { type: ObjectId, ref: 'Quotation' },
    quotationNumber: { type: String, default: '' },
    // Where it came from: an accepted quotation, or a cart sent from the WhatsApp catalog (8C).
    source: { type: String, enum: ['quotation', 'catalog'], default: 'quotation' },
    catalogOrder: {
      messageId: { type: ObjectId, ref: 'Message' },
      conversationId: { type: ObjectId, ref: 'Conversation' },
      catalogId: { type: String },
      text: { type: String },
      warnings: { type: [String], default: undefined },
    },
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
    paidAt: { type: Date }, // paid in full (by payments, or moved to Payment Collected by hand)
    // What the customer has paid (Phase 8): through payment links (one entry per gateway payment)
    // or recorded by hand (cash, bank transfer …). amountPaidPaise is their sum.
    payments: { type: [paymentSchema], default: [] },
    amountPaidPaise: { type: Number, default: 0 },
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
// One order per catalog cart message, however often its job runs.
orderSchema.index({ 'catalogOrder.messageId': 1 }, { unique: true, partialFilterExpression: { 'catalogOrder.messageId': { $type: 'objectId' } } });

module.exports = mongoose.model('Order', orderSchema);
