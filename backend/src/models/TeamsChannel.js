const mongoose = require('mongoose');
const { TEAMS_EVENTS } = require('../constants/microsoft');

// A Microsoft Teams channel the company's notes go to (Phase 4B, D83): a Teams "Workflows"
// webhook address, which carries its own secret signature, so it is kept encrypted and shown
// only as urlHint. events: which business events post a card. Switched off (active false, with
// disabledReason) after three refusals (4xx) in a row; failures (5xx) are retried by the queue.
const teamsChannelSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, trim: true, required: true, maxlength: 100 },
    urlEnc: { type: String, required: true },
    urlHint: { type: String, default: '' },
    events: [{ type: String, enum: TEAMS_EVENTS }],
    active: { type: Boolean, default: true },
    disabledReason: { type: String, default: '' },
    refusals: { type: Number, default: 0 },
    lastStatus: { type: String, enum: ['', 'sent', 'failed'], default: '' },
    lastError: { type: String, default: '' },
    lastSentAt: { type: Date },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

teamsChannelSchema.index({ organizationId: 1, active: 1 });

module.exports = mongoose.model('TeamsChannel', teamsChannelSchema);
