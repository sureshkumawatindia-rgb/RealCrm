const mongoose = require('mongoose');

// One member's Microsoft 365 account (Phase 4B, D83): signed in with PKCE, the tokens kept only
// encrypted (secretBox). It puts the member's CRM meetings in their Outlook calendar, from
// calendarSyncFrom on, and gives meetings a Teams link. status needs_reconnect: Microsoft refused
// the refresh token (revoked or expired); nothing syncs until the member connects again.
const microsoftConnectionSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    microsoftUserId: { type: String, default: '' },
    email: { type: String, trim: true, default: '' },
    name: { type: String, trim: true, default: '' },
    encryptedAccessToken: { type: String, required: true },
    encryptedRefreshToken: { type: String, required: true },
    tokenExpiry: { type: Date, required: true },
    scopes: { type: [String], default: [] },
    calendarSyncFrom: { type: String, default: '' }, // YYYY-MM-DD (India): meetings from this day on
    status: { type: String, enum: ['active', 'needs_reconnect'], default: 'active' },
    lastError: { type: String, default: '' },
    lastSyncAt: { type: Date },
  },
  { timestamps: true },
);

microsoftConnectionSchema.index({ organizationId: 1, memberId: 1 }, { unique: true });

module.exports = mongoose.model('MicrosoftConnection', microsoftConnectionSchema);
