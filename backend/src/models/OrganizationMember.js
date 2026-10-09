const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');
const { ROLES, MODULES } = require('../constants/permissions');

const organizationMemberSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ROLES, required: true },
    modules: { type: [{ type: String, enum: MODULES }], default: [] },
    permissions: { type: [String], default: [] },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    // Last request to the API (written at most once a minute): "online" on the live team page (D61).
    lastSeenAt: { type: Date },
    displayName: { type: String, trim: true, default: '' },
    mobile: { type: String, trim: true, default: '' },
    // What they do in the team ("Sales", "Support", ...), shown on Account Champions.
    title: { type: String, trim: true, default: '' },
    assignable: { type: Boolean, default: true },
    invitedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastAssignedAt: { type: Date },
  },
  { timestamps: true },
);

organizationMemberSchema.plugin(softDelete);
// One document per (organization, user). A removed member who is invited again gets the
// same document back (deletedAt cleared), so this index can stay unconditional.
organizationMemberSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
organizationMemberSchema.index({ userId: 1 });
organizationMemberSchema.index({ organizationId: 1, deletedAt: 1, role: 1 });

module.exports = mongoose.model('OrganizationMember', organizationMemberSchema);
