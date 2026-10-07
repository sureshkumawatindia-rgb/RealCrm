const mongoose = require('mongoose');
const { API_SCOPE_KEYS } = require('../constants/api');

// A key for the public API (Phase 10C). Only a SHA-256 hash of the key is kept: the key itself
// is shown once, when it is made. prefix (ycrm_<prefix>_…) finds the key without the secret.
const apiKeySchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    prefix: { type: String, required: true },
    hash: { type: String, required: true },
    scopes: [{ type: String, enum: API_SCOPE_KEYS }],
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    lastUsedAt: Date,
    lastUsedIp: String,
    revokedAt: Date,
    revokedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

apiKeySchema.index({ prefix: 1 }, { unique: true });
apiKeySchema.index({ organizationId: 1, revokedAt: 1, createdAt: -1 });

module.exports = mongoose.model('ApiKey', apiKeySchema);
