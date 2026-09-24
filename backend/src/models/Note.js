const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { NOTE_PARENT_TYPES } = require('../constants/crm');

// A note on a ticket (its reply timeline) or on a contact (Customer 360 notes).
// authorName is a snapshot; imported notes keep the old author's name without an id.
const noteSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    parentType: { type: String, enum: NOTE_PARENT_TYPES, required: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    text: { type: String, required: true, trim: true },
    authorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    authorMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    authorName: { type: String, trim: true, default: '' },
    legacyIds: { type: [String], default: undefined },
  },
  { timestamps: true },
);

noteSchema.plugin(softDelete);
noteSchema.index({ organizationId: 1, parentType: 1, parentId: 1, createdAt: -1 });
noteSchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('Note', noteSchema);
