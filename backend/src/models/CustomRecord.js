const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

// One record of a company's own object (Phase 1C, D75): a machine, a site, an AMC contract …
// It has a name, may belong to a customer (contactId, shown on Customer 360), has an owner like a
// customer (agents see their own unless they have customers:view_all), and the object's own fields.
const customRecordSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    object: { type: String, required: true }, // CustomObjectDefinition.key
    name: { type: String, required: true, trim: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrganizationMember' },
    // The object's fields: { key: value }, checked by services/customFieldService.js.
    customFields: { type: mongoose.Schema.Types.Mixed },
    version: { type: Number, default: 0 },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

customRecordSchema.plugin(softDelete);
customRecordSchema.index({ organizationId: 1, object: 1, deletedAt: 1, updatedAt: -1 });
customRecordSchema.index({ organizationId: 1, contactId: 1 });
customRecordSchema.index({ organizationId: 1, object: 1, name: 1 });

module.exports = mongoose.model('CustomRecord', customRecordSchema);
