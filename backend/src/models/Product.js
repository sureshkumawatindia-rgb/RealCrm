const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

// Catalog item. Prices are tax-exclusive integer paise (D1, D2); GST is a plain rate
// because the slabs change (2025) and are not hard-coded.
const productSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true },
    sku: { type: String, trim: true, default: '' },
    category: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    unit: { type: String, trim: true, default: 'pcs' },
    hsnSac: { type: String, trim: true, default: '' },
    pricePaise: { type: Number, min: 0, default: 0 },
    gstRatePct: { type: Number, min: 0, max: 100, default: 0 },
    moq: { type: Number, min: 0 },
    stockQty: { type: Number, min: 0 },
    images: { type: [String], default: [] },
    active: { type: Boolean, default: true },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

productSchema.plugin(softDelete);
productSchema.index({ organizationId: 1, deletedAt: 1, active: 1, category: 1 });
productSchema.index({ organizationId: 1, name: 1 });
productSchema.index({ organizationId: 1, legacyIds: 1 });

module.exports = mongoose.model('Product', productSchema);
