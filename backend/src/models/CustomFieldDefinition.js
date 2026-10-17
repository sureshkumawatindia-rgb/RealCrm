const mongoose = require('mongoose');
const { CUSTOM_FIELD_OBJECTS, CUSTOM_FIELD_TYPES, CUSTOM_FIELD_STATUSES } = require('../constants/customFields');

// A field a company added to its customers or leads (Phase 1A, D73). The values live on the
// record (Contact.customFields / Lead.customFields, key → value). object, key and type never
// change. Archiving hides the field and keeps its values; nothing is ever hard-deleted.
const optionSchema = new mongoose.Schema(
  {
    value: { type: String, required: true }, // o1, o2 … never changes, so stored values stay valid
    label: { type: String, required: true, trim: true },
    archived: { type: Boolean, default: false },
  },
  { _id: false },
);

const customFieldDefinitionSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    object: { type: String, enum: CUSTOM_FIELD_OBJECTS, required: true },
    key: { type: String, required: true },
    label: { type: String, required: true, trim: true },
    helpText: { type: String, trim: true, default: '' },
    type: { type: String, enum: CUSTOM_FIELD_TYPES, required: true },
    options: { type: [optionSchema], default: undefined }, // dropdown only
    required: { type: Boolean, default: false },
    // Shown as a column in the Customers / Leads / Deals lists, for the whole company (D74, max 3).
    listColumn: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    status: { type: String, enum: CUSTOM_FIELD_STATUSES, default: 'active' },
    archivedAt: { type: Date },
    archivedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    version: { type: Number, default: 0 },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

customFieldDefinitionSchema.index({ organizationId: 1, object: 1, key: 1 }, { unique: true });
customFieldDefinitionSchema.index({ organizationId: 1, object: 1, status: 1, order: 1 });

module.exports = mongoose.model('CustomFieldDefinition', customFieldDefinitionSchema);
