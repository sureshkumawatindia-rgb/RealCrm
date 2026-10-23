const mongoose = require('mongoose');

const oauthStateSchema = new mongoose.Schema(
  {
    state: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
    returnUrl: { type: String, required: true },
    // D83: whose sign-in this is (Gmail when missing), the member, and Microsoft's PKCE verifier (encrypted).
    provider: { type: String, enum: ['gmail', 'microsoft'], default: 'gmail' },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    codeVerifierEnc: { type: String },
    // D90: the Google features asked for (calendar, drive), besides Gmail.
    features: { type: [String], default: undefined },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true },
);

module.exports = mongoose.model('OAuthState', oauthStateSchema);