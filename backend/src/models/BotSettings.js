const mongoose = require('mongoose');
const { answerSchema } = require('./FaqRule');

// The WhatsApp FAQ bot of an organization (Phase 6C, one document each). The bot answers only
// while no agent has the chat and until the customer asks for a person (D33). Greeting and away
// message go at most once per chat every repeatAfterHours.
const DEFAULT_HANDOFF_KEYWORDS = ['agent', 'human', 'person', 'talk to someone', 'call me', 'baat karni hai'];

const botSettingsSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, unique: true },
    enabled: { type: Boolean, default: false },
    greeting: {
      enabled: { type: Boolean, default: true },
      answer: { type: answerSchema, default: () => ({ text: 'Namaste {{contact.name}}! Welcome to {{org.name}}. How can we help you?' }) },
    },
    away: {
      enabled: { type: Boolean, default: true },
      answer: { type: answerSchema, default: () => ({ text: 'Thank you for your message! We are closed right now and will reply as soon as we open.' }) },
    },
    handoff: {
      keywords: { type: [String], default: () => [...DEFAULT_HANDOFF_KEYWORDS] },
      text: { type: String, trim: true, default: 'Sure! Someone from our team will reply here soon.' },
    },
    repeatAfterHours: { type: Number, min: 1, max: 168, default: 24 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('BotSettings', botSettingsSchema);
module.exports.DEFAULT_HANDOFF_KEYWORDS = DEFAULT_HANDOFF_KEYWORDS;
