const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    googleId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    picture: { type: String, default: '' },
    // The organization the user worked in last. Memberships live in OrganizationMember.
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
    lastLoginAt: { type: Date },
    disabledAt: { type: Date },
    // A mobile number checked with a WhatsApp code (Phase 10E). One user per number.
    phoneE164: { type: String },
    phoneVerifiedAt: { type: Date },
    // 2-step verification (D60, Settings → Your Profile): on a new browser, a WhatsApp code to
    // that number after Google. Off unless switched on.
    twoStepEnabledAt: { type: Date },
  },
  { timestamps: true },
);

userSchema.index({ phoneE164: 1 }, { unique: true, partialFilterExpression: { phoneE164: { $type: 'string' } } });

module.exports = mongoose.model('User', userSchema);
