const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    logoUrl: { type: String, default: '' },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    industry: { type: String, trim: true },
    size: { type: String, trim: true },
    foundedYear: { type: Number },
    website: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    gstin: { type: String, trim: true, uppercase: true },
    stateCode: { type: String, trim: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true },
    postalCode: { type: String, trim: true },
    description: { type: String, trim: true },
    // Quotations and orders (Phase 5): what the PDF shows and how documents are numbered.
    billing: {
      bank: {
        accountName: { type: String, trim: true, default: '' },
        accountNumber: { type: String, trim: true, default: '' },
        ifsc: { type: String, trim: true, uppercase: true, default: '' },
        bankName: { type: String, trim: true, default: '' },
        branch: { type: String, trim: true, default: '' },
      },
      upiId: { type: String, trim: true, default: '' },
      terms: { type: String, default: '' },
      validityDays: { type: Number, min: 1, max: 365, default: 15 },
      prefixes: {
        quotation: { type: String, default: 'QT' },
        estimate: { type: String, default: 'EST' },
        proforma: { type: String, default: 'PI' },
        order: { type: String, default: 'SO' },
      },
      roundOff: { type: Boolean, default: true }, // D28
      reduceStockOnDispatch: { type: Boolean, default: false },
    },
  },
  // strict:false keeps fields written by older versions until a migration moves them.
  { timestamps: true, strict: false },
);

module.exports = mongoose.model('Organization', organizationSchema);
