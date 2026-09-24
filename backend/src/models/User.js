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
  },
  { timestamps: true },
);

module.exports = mongoose.model('User', userSchema);
