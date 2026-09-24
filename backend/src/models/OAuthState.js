const mongoose = require('mongoose');

const oauthStateSchema = new mongoose.Schema(
  {
    state: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    returnUrl: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true },
);

module.exports = mongoose.model('OAuthState', oauthStateSchema);