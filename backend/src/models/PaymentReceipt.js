const mongoose = require('mongoose');

// A receipt for money paid against an order (D101): one per payment (a payment link's or one
// entered by hand), numbered without gaps per financial year (RCPT/26-27/0001). A payment that
// is removed later leaves its receipt cancelled, never deleted, so no number goes missing.
const { ObjectId } = mongoose.Schema.Types;

const paymentReceiptSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    number: { type: String, required: true },
    financialYear: { type: String, required: true },
    receiptDate: { type: Date, required: true }, // when the money came in
    orderId: { type: ObjectId, ref: 'Order', required: true },
    orderNumber: { type: String, default: '' },
    paymentId: { type: ObjectId, required: true }, // the order's payments entry
    invoiceId: { type: ObjectId, ref: 'TaxInvoice' },
    invoiceNumber: { type: String, default: '' },
    contactId: { type: ObjectId, ref: 'Contact' },
    ownerId: { type: ObjectId, ref: 'OrganizationMember' },
    receivedFrom: {
      name: { type: String, default: '' },
      company: { type: String, default: '' },
      gstin: { type: String, default: '' },
    },
    amountPaise: { type: Number, required: true },
    source: { type: String, default: '' }, // link or manual
    method: { type: String, default: '' },
    reference: { type: String, default: '' },
    status: { type: String, enum: ['issued', 'cancelled'], default: 'issued' },
    cancelledAt: { type: Date },
    sentAt: { type: Date },
  },
  { timestamps: true },
);

paymentReceiptSchema.index({ organizationId: 1, number: 1 }, { unique: true });
paymentReceiptSchema.index({ organizationId: 1, paymentId: 1 }, { unique: true });
paymentReceiptSchema.index({ organizationId: 1, orderId: 1, createdAt: 1 });

module.exports = mongoose.model('PaymentReceipt', paymentReceiptSchema);
