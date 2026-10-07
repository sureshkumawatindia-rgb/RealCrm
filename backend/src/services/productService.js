const Product = require('../models/Product');
const tenantRepository = require('../repositories/tenantRepository');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { searchFilter, sortSpec } = require('../utils/listQuery');

const SEARCH_FIELDS = ['name', 'category', 'sku'];
const SORTS = ['name', 'category', 'pricePaise', 'stockQty', 'createdAt'];

function serializeProduct(product) {
  return {
    id: product._id,
    name: product.name,
    sku: product.sku,
    category: product.category,
    description: product.description,
    unit: product.unit,
    hsnSac: product.hsnSac,
    pricePaise: product.pricePaise,
    gstRatePct: product.gstRatePct,
    moq: product.moq ?? null,
    stockQty: product.stockQty ?? null,
    images: product.images,
    active: product.active,
    inCatalog: Boolean(product.catalog?.include),
    catalog: { status: product.catalog?.status || (product.catalog?.include ? 'pending' : ''), error: product.catalog?.error || '', retailerId: product.catalog?.retailerId || '', syncedAt: product.catalog?.syncedAt || null },
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

const repo = (req) => tenantRepository(Product, req.tenant.organizationId);

async function findInOrg(req, id) {
  const product = await repo(req).findById(id);
  if (!product) throw httpError(404, 'NOT_FOUND', 'Product not found');
  return product;
}

async function list(req, query) {
  const filter = {
    ...searchFilter(query.q, SEARCH_FIELDS),
    ...(query.category && { category: query.category }),
    ...(query.active !== undefined && { active: query.active }),
  };
  const { items, pagination } = await repo(req).paginate(filter, query, { sort: sortSpec(query.sort, SORTS, { name: 1, _id: 1 }) });
  return { items: items.map(serializeProduct), pagination };
}

// "In the WhatsApp catalog" (Phase 8C): included products wait for the next catalog sync.
function catalogFields({ inCatalog, ...rest }) {
  return inCatalog === undefined ? rest : { ...rest, 'catalog.include': inCatalog, ...(inCatalog && { 'catalog.status': 'pending', 'catalog.error': '' }) };
}

async function create(req, body) {
  const { inCatalog, ...fields } = body;
  const product = await repo(req).create({ ...fields, ...(inCatalog && { catalog: { include: true, status: 'pending' } }), createdById: req.user._id });
  await audit(req, { action: 'product.created', entityType: 'Product', entityId: product._id });
  return serializeProduct(product);
}

async function update(req, id, patch) {
  const product = await findInOrg(req, id);
  const before = { pricePaise: product.pricePaise, gstRatePct: product.gstRatePct, stockQty: product.stockQty };
  product.set(catalogFields(patch));
  // A change Meta shows (name, price, photo …) of a product in the catalog goes at the next sync.
  if (product.catalog?.include && product.catalog.status === 'synced' && ['name', 'description', 'pricePaise', 'gstRatePct', 'images', 'sku', 'stockQty', 'active'].some((field) => patch[field] !== undefined)) {
    product.set('catalog.status', 'pending');
  }
  await product.save();
  await audit(req, { action: 'product.updated', entityType: 'Product', entityId: product._id, changes: { before, after: patch } });
  return serializeProduct(product);
}

async function remove(req, id) {
  const product = await findInOrg(req, id);
  await product.softDelete();
  await audit(req, { action: 'product.deleted', entityType: 'Product', entityId: product._id });
}

module.exports = {
  list, create, update, remove, serializeProduct,
  get: async (req, id) => serializeProduct(await findInOrg(req, id)),
  findInOrg,
};
