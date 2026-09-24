const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { DOCUMENT_CATEGORIES, RELATED_TYPES } = require('../constants/crm');

// A document is either an uploaded file (storageKey + file details) or a web link (linkUrl).
// The file itself lives in private storage (src/storage), never in the database.
const documentSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    category: { type: String, enum: DOCUMENT_CATEGORIES, default: 'Other' },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    relatedType: { type: String, enum: RELATED_TYPES, default: '' },
    relatedId: { type: mongoose.Schema.Types.ObjectId },
    relatedName: { type: String, trim: true, default: '' },
    tags: { type: [String], default: [] },
    storageKey: { type: String },
    fileName: { type: String, trim: true, default: '' },
    mimeType: { type: String, trim: true, default: '' },
    sizeBytes: { type: Number, min: 0, default: 0 },
    // SHA-256 of the file, to spot duplicates and damaged files.
    checksum: { type: String, default: '' },
    linkUrl: { type: String, trim: true, default: '' },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
  },
  { timestamps: true },
);

documentSchema.plugin(softDelete);
documentSchema.index({ organizationId: 1, deletedAt: 1, category: 1, createdAt: -1 });
documentSchema.index({ organizationId: 1, ownerId: 1, createdAt: -1 });
documentSchema.index({ organizationId: 1, relatedType: 1, relatedId: 1 });
documentSchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('Document', documentSchema);
