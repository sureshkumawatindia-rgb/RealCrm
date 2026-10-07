const mongoose = require('mongoose');
const { PLAN_KEYS } = require('../constants/plans');

// The billing gateway's plan for one CRM plan at one price (Phase 10B). Made the first time
// someone chooses that plan, so the platform never types plan ids; a new price makes a new one.
const billingPlanSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true },
    keyId: { type: String, default: '' }, // test and live keys have their own plans
    planKey: { type: String, enum: PLAN_KEYS, required: true },
    amountPaise: { type: Number, required: true }, // charged each month, GST included
    providerPlanId: { type: String, required: true },
  },
  { timestamps: true },
);

billingPlanSchema.index({ provider: 1, keyId: 1, planKey: 1, amountPaise: 1 }, { unique: true });
billingPlanSchema.index({ provider: 1, providerPlanId: 1 });

module.exports = mongoose.model('BillingPlan', billingPlanSchema);
