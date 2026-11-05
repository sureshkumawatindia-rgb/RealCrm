const mongoose = require('mongoose');
const { PLAN_KEYS, TRIAL_PLAN, SUBSCRIPTION_STATUSES } = require('../constants/plans');
const { codeFromName, uniqueCode } = require('../utils/workspaceCode');
const { KIT_IDS } = require('../constants/businessKits');

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // The workspace code its team types on the login page (D66), made from the name; owners and
    // admins can change it in Settings → Company. Unique (index below).
    slug: { type: String, trim: true, lowercase: true },
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
    // Extras the platform owner gave this company on top of its plan (Phase 3A, D80; made with
    // scripts/plan.js): a limit + extra, or a feature switched on, until a date or for good.
    // Every server check uses the plan plus the grants in force; ended grants stay as history.
    entitlementGrants: [{
      key: { type: String, required: true }, // a LIMITS or FEATURES key of constants/plans.js
      extra: { type: Number, min: 1 }, // for a limit; absent for a feature
      until: Date,
      reason: { type: String, trim: true, maxlength: 200, default: '' },
      by: { type: String, trim: true, maxlength: 100, default: 'platform' },
      at: { type: Date, default: Date.now },
    }],
    // The day (India, YYYY-MM-DD) of the last usage snapshot, and the last usage alert sent per
    // meter ({ level: 80 | 100, period: 'YYYY-MM' | 'always' }) (Phase 3A, D80).
    usageSnapshotOn: { type: String },
    usageAlerts: { type: mongoose.Schema.Types.Mixed },
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
        // D101: tax invoices, credit notes and payment receipts (INV/26-27/0001: at most 4 letters,
        // so a number stays within GST's 16 characters).
        invoice: { type: String, default: 'INV' },
        creditNote: { type: String, default: 'CN' },
        receipt: { type: String, default: 'RCPT' },
      },
      roundOff: { type: Boolean, default: true }, // D28
      reduceStockOnDispatch: { type: Boolean, default: false },
      // D101: make the tax invoice by itself when an order is moved to Dispatched (off: by hand).
      invoiceOnDispatch: { type: Boolean, default: false },
    },
    // An owner asked to delete the company (Phase 10F): it keeps working until scheduledFor, then
    // a job removes all its data. Cancelled by an owner before then.
    // The day (India time, YYYY-MM-DD) the owners last got the evening team summary (D61).
    teamSummarySentOn: { type: String },
    // Company-wide choices for the team (Settings → Team & Access). hidePhonesFromAgents (D65):
    // agents and viewers see customers' numbers masked; missing counts as on.
    settings: {
      hidePhonesFromAgents: { type: Boolean, default: true },
      // CP3: when a teammate opens a chat, the customer sees blue ticks; missing counts as on.
      sendReadReceipts: { type: Boolean, default: true },
      // D103: after a chat is resolved, ask the customer "How was our service?" (off by default).
      csat: { enabled: { type: Boolean, default: false }, question: { type: String, default: '' } },
      // G3 (D107): ticket SLA — on by default; limits by priority in minutes ({ Urgent: { reply,
      // resolve } … }, missing = the defaults in constants/crm.js); counted in working hours.
      ticketSla: {
        enabled: { type: Boolean, default: true },
        workingHoursOnly: { type: Boolean, default: true },
        limits: { type: mongoose.Schema.Types.Mixed },
      },
      // G5 (D109): the Tally export's ledger names, as in the company's Tally ({ sales, cgst, sgst,
      // igst, roundOff, bank, cash, gateway }; missing = the defaults in services/tallyService.js),
      // and one sales ledger per GST rate ("Sales 18%") or one for all.
      tally: {
        ledgers: { type: mongoose.Schema.Types.Mixed },
        splitByRate: { type: Boolean, default: false },
      },
      // D76: pages the company does not use, left out of everyone's menu and search (not a
      // permission: a direct link still opens). Only HIDEABLE_MODULES; missing = every page used.
      hiddenModules: { type: [String], default: undefined },
      // D92: a won deal starts its delivery project by itself, with this template.
      projectsOnWon: { enabled: { type: Boolean, default: false }, templateId: { type: mongoose.Schema.Types.ObjectId } },
      // F2: when made-up data was added on staging (once per company).
      sampleDataAt: { type: Date },
    },
    // First steps after sign-up (D64): when an owner or admin finished or skipped "Invite your team".
    // D117: the ready settings the company chose (constants/businessKits.js) and when.
    onboarding: {
      teamStepAt: Date,
      kit: { type: String, enum: KIT_IDS },
      kitAt: Date,
    },
    deletion: {
      requestedAt: Date,
      scheduledFor: Date,
      requestedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      remindedAt: Date, // D104: the "deleted tomorrow" email went out
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
    // Custom fields (D73): raised inside the transaction that adds or restores a field, so two
    // admins doing it at the same moment are taken one after the other and the limit holds.
    customFieldsRevision: { type: Number },
  },
  // strict:false keeps fields written by older versions until a migration moves them.
  { timestamps: true, strict: false },
);

// Organizations from before D66 get their code from migration 006; until then they have none.
organizationSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { slug: { $type: 'string' } } });

// A new organization (or one saved before migration 006 ran) gets the first free code from its name.
organizationSchema.pre('validate', async function assignWorkspaceCode() {
  if (this.slug || !this.name) return;
  this.slug = await uniqueCode(this.constructor, codeFromName(this.name), { session: this.$session(), organizationId: this._id });
});

module.exports = mongoose.model('Organization', organizationSchema);
