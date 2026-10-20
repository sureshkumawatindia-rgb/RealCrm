const mongoose = require('mongoose');
const { isObjectKey } = require('../constants/customFields');

// How an object's custom fields are grouped in the forms (Phase 1D, D76): named sections in
// order, each 1 or 2 columns. One per company and object. A field belongs to a section through
// CustomFieldDefinition.sectionId; fields without one are shown under "More details".
const sectionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true }, // s1, s2 … never reused (lastSectionNumber)
    label: { type: String, required: true, trim: true },
    columns: { type: Number, enum: [1, 2], default: 1 },
  },
  { _id: false },
);

const customFieldLayoutSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    object: { type: String, required: true, validate: { validator: isObjectKey, message: 'Unknown object' } },
    sections: { type: [sectionSchema], default: [] },
    lastSectionNumber: { type: Number, default: 0 },
    version: { type: Number, default: 0 },
    updatedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

customFieldLayoutSchema.index({ organizationId: 1, object: 1 }, { unique: true });

module.exports = mongoose.model('CustomFieldLayout', customFieldLayoutSchema);
