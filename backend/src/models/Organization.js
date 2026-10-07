const mongoose = require('mongoose');
const { PLAN_KEYS, TRIAL_PLAN, SUBSCRIPTION_STATUSES } = require('../constants/plans');

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
    // The SaaS plan (constants/plans.js) and where its subscription stands (Phase 10,
    // services/planService.js). No defaults on purpose: an organization from before billing has
    // no status and counts as comped (D48); a new one starts a 30-day trial at sign-up.
    plan: { type: String, enum: PLAN_KEYS, default: TRIAL_PLAN },
    subscription: {
      status: { type: String, enum: SUBSCRIPTION_STATUSES },
      since: Date,
      trialEndsAt: Date,
      currentPeriodStart: Date,
      currentPeriodEnd: Date,
      cancelAtPeriodEnd: Boolean,
      provider: String,
      providerSubscriptionId: String,
      providerCustomerId: String,
      pendingPlan: { type: String, enum: PLAN_KEYS },
      gatewayStatus: String, // the billing gateway's own word (created, authenticated, active …)
      checkoutUrl: String, // the gateway's payment page while the first payment is awaited
      remindedFor: String, // the last trial reminder sent ("7", "3", "1", "ended"), once each
    },
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
    // The AI assistant (Phase 10D, Settings → AI assistant): off until an owner or admin turns it
    // on; autoReply lets it answer customers by itself (else it only drafts replies for agents).
    ai: {
      enabled: { type: Boolean, default: false },
      autoReply: { type: Boolean, default: false },
      instructions: { type: String, default: '' },
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
