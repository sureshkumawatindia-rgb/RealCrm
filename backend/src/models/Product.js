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
    // The WhatsApp catalog (Phase 8C): include = shown to customers in WhatsApp; retailerId is the
    // id Meta knows it by (the SKU, else this product's id) as last sent; status of the last sync.
    catalog: {
      include: { type: Boolean, default: false },
      retailerId: { type: String },
      status: { type: String, enum: ['pending', 'synced', 'error', 'removed'] },
      error: { type: String, default: '' },
      syncedAt: { type: Date },
    },
    legacyIds: { type: [String], default: undefined },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

productSchema.plugin(softDelete);
productSchema.index({ organizationId: 1, deletedAt: 1, active: 1, category: 1 });
productSchema.index({ organizationId: 1, name: 1 });
productSchema.index({ organizationId: 1, legacyIds: 1 });
productSchema.index({ organizationId: 1, 'catalog.retailerId': 1 }, { sparse: true });

module.exports = mongoose.model('Product', productSchema);
