const mongoose = require('mongoose');

// A GST tax invoice from the platform to an organization for one paid month of its plan
// (Phase 10B). One per gateway payment; the seller and buyer are copied in when it is issued,
// so a later change of address never changes an issued invoice.
const partySchema = new mongoose.Schema(
  { name: String, gstin: String, address: String, stateCode: String, state: String, email: String },
  { _id: false },
);

const billingInvoiceSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    number: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    planKey: String,
    planName: String,
    periodStart: Date,
    periodEnd: Date,
    sac: String,
    seller: partySchema,
    buyer: partySchema,
    placeOfSupplyCode: String,
    taxablePaise: { type: Number, required: true },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 },
    igstPaise: { type: Number, default: 0 },
    totalPaise: { type: Number, required: true }, // what was paid
    provider: String,
    providerPaymentId: { type: String, required: true },
    providerInvoiceId: String,
    providerSubscriptionId: String,
  },
  { timestamps: true },
);

billingInvoiceSchema.index({ number: 1 }, { unique: true });
billingInvoiceSchema.index({ provider: 1, providerPaymentId: 1 }, { unique: true });
billingInvoiceSchema.index({ organizationId: 1, issuedAt: -1 });

module.exports = mongoose.model('BillingInvoice', billingInvoiceSchema);
