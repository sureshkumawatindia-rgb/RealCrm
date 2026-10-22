const mongoose = require('mongoose');
const { BOARD_LAYOUTS, BOARD_OBJECT_KEYS } = require('../constants/boards');

// A saved board view (Phase 7B, D87): leads or tasks as a table, a Kanban board or a calendar,
// with its own columns and filters. Its maker sees it; shared views are seen by the whole team
// (members who can open that module). The records themselves are read through the lead and task
// lists, so each viewer sees only what they may.
const { Mixed, ObjectId } = mongoose.Schema.Types;

const boardViewSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: 'Organization', required: true },
    object: { type: String, enum: BOARD_OBJECT_KEYS, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    layout: { type: String, enum: BOARD_LAYOUTS, default: 'table' },
    filters: { type: Mixed, default: () => ({}) },
    columns: { type: [String], default: [] },
    groupBy: { type: String, default: '' },
    dateField: { type: String, default: '' },
    sort: { type: String, default: '' },
    shared: { type: Boolean, default: false },
    ownerMemberId: { type: ObjectId, ref: 'OrganizationMember', required: true },
    createdById: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

boardViewSchema.index({ organizationId: 1, ownerMemberId: 1, object: 1 });
boardViewSchema.index({ organizationId: 1, shared: 1, object: 1 });

module.exports = mongoose.model('BoardView', boardViewSchema);
