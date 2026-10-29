const mongoose = require('mongoose');
const { itemSchema, partySchema, supplySchema, totalsSchema, sellerSchema } = require('./schemas/documentParts');

// A GST tax invoice for an order, or a credit note against one (D101; CGST Rules 46 and 53).
// Numbered without gaps per financial year (INV/26-27/0001, CN/26-27/0001: at most 16
// characters). Once made it is never edited: a mistake is put right with a credit note, which
// takes back the whole invoice or part of its lines. The money comes from utils/gst like
// quotations and orders.
const { ObjectId } = mongoose.Schema.Types;

// A line of a credit note: the invoice line it takes back (lineIndex) and how much.
const creditLineSchema = itemSchema.clone();
creditLineSchema.add({ lineIndex: { type: Number, min: 0 } });

// How much of an invoice line credit notes have taken back so far.
const creditedSchema = new mongoose.Schema(
  {
    lineIndex: { type: Number, required: true },
    quantity: { type: Number, default: 0 },
    taxablePaise: { type: Number, default: 0 },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 },
    igstPaise: { type: Number, default: 0 },
  },
  { _id: false },
);

const taxInvoiceSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    kind: { type: String, enum: ['invoice', 'credit_note'], required: true },
    number: { type: String, required: true },
    financialYear: { type: String, required: true }, // 2026-27
    invoiceDate: { type: Date, required: true },
    orderId: { type: ObjectId, ref: 'Order', required: true },
    orderNumber: { type: String, default: '' },
    quotationId: { type: ObjectId, ref: 'Quotation' },
    leadId: { type: ObjectId, ref: 'Lead' },
    contactId: { type: ObjectId, ref: 'Contact' },
    ownerId: { type: ObjectId, ref: 'OrganizationMember' }, // the order's, for reports
    seller: { type: sellerSchema, default: () => ({}) },
    billTo: { type: partySchema, default: () => ({}) },
    supply: { type: supplySchema, default: () => ({}) },
    items: { type: [creditLineSchema], default: [] },
    totals: { type: totalsSchema, default: () => ({}) },
    terms: { type: String, default: '' },
    // An invoice: issued, or credited (taken back in full by credit notes).
    status: { type: String, enum: ['issued', 'credited'], default: 'issued' },
    credited: { type: [creditedSchema], default: [] },
    creditedPaise: { type: Number, default: 0 }, // the credit notes' totals
    // A credit note: the invoice it takes back from, and why.
    invoiceId: { type: ObjectId, ref: 'TaxInvoice' },
    invoiceNumber: { type: String, default: '' },
    originalDate: { type: Date },
    reason: { type: String, default: '' },
    full: { type: Boolean, default: false }, // takes back the whole invoice
    auto: { type: Boolean, default: false }, // made when the order was dispatched
    sentAt: { type: Date },
    createdById: { type: ObjectId, ref: 'User' },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true },
);

taxInvoiceSchema.index({ organizationId: 1, number: 1 }, { unique: true });
taxInvoiceSchema.index({ organizationId: 1, orderId: 1, kind: 1, createdAt: 1 });
taxInvoiceSchema.index({ organizationId: 1, invoiceId: 1 });
taxInvoiceSchema.index({ organizationId: 1, kind: 1, invoiceDate: -1 });
// One live invoice per order: another can be made only after this one was credited in full.
taxInvoiceSchema.index(
  { organizationId: 1, orderId: 1 },
  { unique: true, partialFilterExpression: { kind: 'invoice', status: 'issued' }, name: 'one_live_invoice_per_order' },
);

module.exports = mongoose.model('TaxInvoice', taxInvoiceSchema);
