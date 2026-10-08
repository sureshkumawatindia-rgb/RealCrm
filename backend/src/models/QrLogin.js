const mongoose = require('mongoose');

// Logging in a computer from the phone (login, 2026-10-08), like WhatsApp Web: the computer's
// login page shows a QR code (an id and a secret, valid 2 minutes); a phone where the person is
// signed in scans it and allows it; the computer, which keeps asking with the same secret, then
// gets a session for that person and company. Only a hash of the secret is stored; a code works once.
const qrLoginSchema = new mongoose.Schema(
  {
    secretHash: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'used', 'declined'], default: 'pending' },
    expiresAt: { type: Date, required: true },
    computerUserAgent: { type: String, default: '' },
    computerIp: { type: String, default: '' },
    approvedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization' },
    approvedAt: Date,
  },
  { timestamps: true },
);

qrLoginSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 });

module.exports = mongoose.model('QrLogin', qrLoginSchema);
