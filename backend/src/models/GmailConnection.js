const mongoose = require('mongoose');

const gmailConnectionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    emailAddress: { type: String, required: true, lowercase: true, trim: true },
    encryptedAccessToken: { type: String, required: true },
    encryptedRefreshToken: { type: String, required: true },
    tokenExpiry: { type: Date },
    historyId: { type: String, default: '' },
    scopes: { type: [String], default: [] },
  },
  { timestamps: true },
);

module.exports = mongoose.model('GmailConnection', gmailConnectionSchema);