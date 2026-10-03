const mongoose = require('mongoose');

// One answer of the WhatsApp FAQ bot (Phase 6C): when a customer's message contains one of the
// keywords (or they tap an option that points here), the bot answers with the text and up to
// 10 options — 1 to 3 become reply buttons, 4 to 10 a list (WhatsApp's limits). An option opens
// another rule or hands the chat to a person. Rules are tried in priority order.
const { ObjectId } = mongoose.Schema.Types;

const optionSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true }, // ≤ 20 for buttons, ≤ 24 for list rows
    description: { type: String, trim: true, default: '' }, // list rows only, ≤ 72
    action: { type: String, enum: ['rule', 'handoff'], required: true },
    ruleId: { type: ObjectId, ref: 'FaqRule' },
  },
  { _id: false },
);

// The same shape is used for the bot's greeting and away message (BotSettings).
const answerSchema = new mongoose.Schema(
  {
    text: { type: String, trim: true, default: '' }, // ≤ 1024; may use {{contact.name}}, {{org.name}} …
    options: { type: [optionSchema], default: [] },
    listButton: { type: String, trim: true, default: 'Choose' }, // the list's button, ≤ 20
    footer: { type: String, trim: true, default: '' }, // ≤ 60
  },
  { _id: false },
);

const faqRuleSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
    priority: { type: Number, default: 100 },
    keywords: { type: [String], default: [] }, // none: only reachable from another answer's option
    answer: { type: answerSchema, default: () => ({}) },
    stats: {
      answered: { type: Number, default: 0 },
      lastAnsweredAt: { type: Date },
    },
    createdById: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

faqRuleSchema.index({ organizationId: 1, active: 1, priority: 1 });

module.exports = mongoose.model('FaqRule', faqRuleSchema);
module.exports.answerSchema = answerSchema;
