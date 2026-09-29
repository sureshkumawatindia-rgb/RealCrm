const mongoose = require('mongoose');
const { LEAD_SOURCES } = require('../constants/crm');

// "When a lead arrives from these sources, send this approved WhatsApp template" (Phase 4).
// The first active rule (by priority) that fits the lead's source is used, once per enquiry.
// variables maps each template variable to a value: "contact.name", "contact.company",
// "contact.city", "lead.product", "owner.name", "org.name", or fixed text as "text:<words>".
const autoReplyRuleSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, trim: true, default: '' },
    active: { type: Boolean, default: true },
    priority: { type: Number, default: 100 },
    sources: { type: [{ type: String, enum: LEAD_SOURCES }], default: [] },
    // Only people the CRM did not know yet (a repeat enquiry gets no second greeting).
    onlyNewContacts: { type: Boolean, default: true },
    // Enquiries older than this (e.g. from IndiaMART's first 24-hour pull) get no auto-reply.
    maxAgeMinutes: { type: Number, default: 60 },
    delaySeconds: { type: Number, default: 0 },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageTemplate', required: true },
    variables: {
      header: { type: mongoose.Schema.Types.Mixed, default: {} },
      body: { type: mongoose.Schema.Types.Mixed, default: {} },
      buttons: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    stats: {
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      lastSentAt: { type: Date },
    },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

autoReplyRuleSchema.index({ organizationId: 1, active: 1, priority: 1 });

module.exports = mongoose.model('AutoReplyRule', autoReplyRuleSchema);
