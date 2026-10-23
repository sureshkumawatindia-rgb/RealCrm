const mongoose = require('mongoose');

// One person's Google account (Gmail since the start; Calendar and Drive since Phase 9, D90).
// Tokens are kept only encrypted. historyId is the Gmail sync cursor; a stale one means a full
// sync again. status needs_reconnect: Google refused the grant (revoked or expired); nothing
// syncs until the person connects again. shareEmails: the team sees the synced emails with
// customers (subject and snippet) on the customer's history; off, only this person does.
const gmailConnectionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    emailAddress: { type: String, required: true, lowercase: true, trim: true },
    encryptedAccessToken: { type: String, required: true },
    encryptedRefreshToken: { type: String, required: true },
    tokenExpiry: { type: Date },
    historyId: { type: String, default: '' },
    scopes: { type: [String], default: [] },
    features: {
      calendar: { type: Boolean, default: false },
      drive: { type: Boolean, default: false },
    },
    status: { type: String, enum: ['active', 'needs_reconnect'], default: 'active' },
    lastError: { type: String, default: '' },
    shareEmails: { type: Boolean, default: true },
    lastSyncAt: { type: Date },
    lastSyncCount: { type: Number, default: 0 },
    calendarSyncFrom: { type: String, default: '' }, // YYYY-MM-DD (India): meetings from this day on
  },
  { timestamps: true },
);

module.exports = mongoose.model('GmailConnection', gmailConnectionSchema);
