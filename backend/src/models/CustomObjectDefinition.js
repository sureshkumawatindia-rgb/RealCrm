const mongoose = require('mongoose');
const { CUSTOM_FIELD_STATUSES, OBJECT_ICONS } = require('../constants/customFields');

// A company's own kind of record (Phase 1C, D75): Machines, Sites, AMC contracts … Its records are
// CustomRecord documents; its fields are CustomFieldDefinition documents with object = key.
// The key never changes. Archiving hides the object and keeps its records; nothing is ever
// hard-deleted.
const customObjectDefinitionSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    key: { type: String, required: true }, // x_machines
    singular: { type: String, required: true, trim: true },
    plural: { type: String, required: true, trim: true },
    icon: { type: String, enum: OBJECT_ICONS, default: 'box' },
    order: { type: Number, default: 0 },
    status: { type: String, enum: CUSTOM_FIELD_STATUSES, default: 'active' },
    archivedAt: { type: Date },
    version: { type: Number, default: 0 },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

customObjectDefinitionSchema.index({ organizationId: 1, key: 1 }, { unique: true });
customObjectDefinitionSchema.index({ organizationId: 1, status: 1, order: 1 });

module.exports = mongoose.model('CustomObjectDefinition', customObjectDefinitionSchema);
