const mongoose = require('mongoose');

// One sign-in code sent on WhatsApp (Phase 10E): to sign in with a verified mobile number, or to
// verify a number for one's own account. Only an HMAC of the code is kept; a code works once,
// for 5 minutes, with 5 tries. A request for a number that belongs to nobody is stored too
// (without sending anything), so the limits look the same for every number.
const otpChallengeSchema = new mongoose.Schema(
  {
    phoneE164: { type: String, required: true },
    purpose: { type: String, enum: ['login', 'link'], required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    codeHash: { type: String, required: true },
    sent: { type: Boolean, default: false },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    consumedAt: Date,
    ip: { type: String, default: '' },
  },
  { timestamps: true },
);

otpChallengeSchema.index({ phoneE164: 1, purpose: 1, createdAt: -1 });
otpChallengeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('OtpChallenge', otpChallengeSchema);
