const mongoose = require('mongoose');

// Browsers a person has logged in from (D63). Logging in from one that is not here sends them a
// "New login" alert. The browser keeps a random token in an httpOnly cookie (crm_browser); only its
// SHA-256 is stored. Unlike TrustedDevice ("stay logged in", skips the WhatsApp code), this
// changes nothing about how they log in.
const knownBrowserSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true },
    userAgent: { type: String, default: '' },
    lastLoginAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

knownBrowserSchema.index({ tokenHash: 1 }, { unique: true });
knownBrowserSchema.index({ userId: 1 });
knownBrowserSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('KnownBrowser', knownBrowserSchema);
