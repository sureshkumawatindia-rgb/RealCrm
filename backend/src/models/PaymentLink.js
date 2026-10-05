const mongoose = require('mongoose');
const { PAYMENT_PROVIDER_KEYS, LINK_STATUSES } = require('../constants/payments');

// A payment link made through the organization's gateway (Phase 8), for an order, a quotation or
// an amount for a customer. referenceId is ours (Razorpay's reference_id, Cashfree's link_id);
// providerLinkId is what the gateway calls it (Razorpay plink_…, Cashfree = our link_id).
// payments[] lists each payment the gateway reported once (unique by providerPaymentId), so a
// webhook and the status check finding the same payment never count it twice.
const { ObjectId } = mongoose.Schema.Types;

const paymentSchema = new mongoose.Schema(
  {
    providerPaymentId: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    method: { type: String, default: '' },
    paidAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const paymentLinkSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    connectionId: { type: ObjectId, ref: 'PaymentConnection', required: true },
    provider: { type: String, enum: PAYMENT_PROVIDER_KEYS, required: true },
    mode: { type: String, enum: ['test', 'live'], default: 'test' },
    referenceId: { type: String, required: true },
    providerLinkId: { type: String, required: true },
    shortUrl: { type: String, default: '' },
    purpose: { type: String, enum: ['order', 'quotation', 'amount'], required: true },
    orderId: { type: ObjectId, ref: 'Order' },
    quotationId: { type: ObjectId, ref: 'Quotation' },
    contactId: { type: ObjectId, ref: 'Contact' },
    leadId: { type: ObjectId, ref: 'Lead' },
    // Copied from the order / quotation / customer, so agents see the links of their customers.
    ownerId: { type: ObjectId, ref: 'OrganizationMember' },
    documentNumber: { type: String, default: '' }, // the order or quotation number
    description: { type: String, default: '' },
    customerName: { type: String, default: '' },
    amountPaise: { type: Number, required: true },
    amountPaidPaise: { type: Number, default: 0 },
    acceptPartial: { type: Boolean, default: false },
    minPartialPaise: { type: Number },
    status: { type: String, enum: LINK_STATUSES, default: 'created' },
    expiresAt: { type: Date },
    paidAt: { type: Date },
    cancelledAt: { type: Date },
    payments: { type: [paymentSchema], default: [] },
    // The WhatsApp message that carried the link, and the receipt after the payment.
    sentMessageId: { type: ObjectId, ref: 'Message' },
    sentAt: { type: Date },
    receipts: {
      type: [{ _id: false, providerPaymentId: String, status: { type: String, enum: ['sent', 'skipped', 'failed'] }, reason: String, messageId: { type: ObjectId, ref: 'Message' }, at: Date }],
      default: [],
    },
    lastSyncedAt: { type: Date },
    lastSyncError: { type: String, default: '' },
    createdById: { type: ObjectId, ref: 'User' },
    createdByMemberId: { type: ObjectId, ref: 'OrganizationMember' },
  },
  { timestamps: true },
);

paymentLinkSchema.index({ provider: 1, providerLinkId: 1 }, { unique: true });
paymentLinkSchema.index({ referenceId: 1 }, { unique: true });
paymentLinkSchema.index({ organizationId: 1, createdAt: -1 });
paymentLinkSchema.index({ organizationId: 1, orderId: 1 });
paymentLinkSchema.index({ organizationId: 1, quotationId: 1 });
paymentLinkSchema.index({ organizationId: 1, contactId: 1 });
paymentLinkSchema.index({ status: 1, lastSyncedAt: 1 });

module.exports = mongoose.model('PaymentLink', paymentLinkSchema);
