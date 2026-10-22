const mongoose = require('mongoose');
const { CALL_DIRECTIONS, CALL_STATUSES, CALL_OUTCOMES, CALL_PROVIDERS } = require('../constants/calls');

// One phone call with a customer (Phase 6, D85): logged by hand, or made through the company's
// telephony connection (click-to-call) and kept up to date by its status webhook. No recording
// is ever stored (no provider or retention decision yet), only who, when, how long and what came
// of it. providerCallId is unique per company and provider, so a repeated webhook finds the same call.
const callSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    direction: { type: String, enum: CALL_DIRECTIONS, default: 'out' },
    status: { type: String, enum: CALL_STATUSES, default: 'completed' },
    outcome: { type: String, enum: CALL_OUTCOMES },
    durationSec: { type: Number, min: 0, default: 0 },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    provider: { type: String, enum: CALL_PROVIDERS, default: 'manual' },
    providerCallId: { type: String },
    connectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'TelephonyConnection' },
    fromNumber: { type: String, default: '' },
    toNumber: { type: String, default: '' },
    error: { type: String, default: '' },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

callSchema.index({ organizationId: 1, contactId: 1, startedAt: -1 });
callSchema.index({ organizationId: 1, memberId: 1, startedAt: -1 });
callSchema.index({ organizationId: 1, leadId: 1, startedAt: -1 });
callSchema.index({ organizationId: 1, provider: 1, providerCallId: 1 }, { unique: true, partialFilterExpression: { providerCallId: { $type: 'string' } } });

module.exports = mongoose.model('Call', callSchema);
