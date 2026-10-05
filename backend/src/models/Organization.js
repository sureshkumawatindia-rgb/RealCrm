const mongoose = require('mongoose');
const { PLAN_KEYS, TRIAL_PLAN } = require('../constants/plans');

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
    // The SaaS plan (constants/plans.js). Until billing (Phase 10) everyone has the trial (D34).
    plan: { type: String, enum: PLAN_KEYS, default: TRIAL_PLAN },
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
    // Payment links (Phase 8, Settings → Payments): how long a link lives, and the approved
    // WhatsApp templates for a link or a receipt when the customer's 24-hour window is closed.
    payments: {
      expiryDays: { type: Number, min: 1, max: 180, default: 7 },
      sendReceipt: { type: Boolean, default: true },
      linkTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageTemplate' },
      receiptTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageTemplate' },
    },
  },
  // strict:false keeps fields written by older versions until a migration moves them.
  { timestamps: true, strict: false },
);

module.exports = mongoose.model('Organization', organizationSchema);
