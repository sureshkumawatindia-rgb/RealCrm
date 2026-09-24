const mongoose = require('mongoose');
const Quotation = require('../models/Quotation');
const Product = require('../models/Product');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { nextSequence } = require('../utils/counter');
const { financialYear } = require('../utils/money');
const { toPage, paginationMeta } = require('../utils/pagination');
const { visibilityFilter } = require('./access');
const leadService = require('./leadService');

const MODULES = leadService.MODULES;

// Line maths in integer paise: subtotal = qty × unit price; tax on (subtotal − discount).
// The browser only sends quantities, prices, discounts and rates; totals are always computed here.
function computeItem(input, product) {
  const quantity = Number(input.quantity) || 0;
  const unitPricePaise = Math.round(Number(input.unitPricePaise) || 0);
  const subtotalPaise = Math.round(quantity * unitPricePaise);
  const discountPaise = Math.min(Math.round(Number(input.discountPaise) || 0), subtotalPaise);
  const taxRatePct = Number(input.taxRatePct) || 0;
  const taxPaise = Math.round(((subtotalPaise - discountPaise) * taxRatePct) / 100);
  return {
    productId: input.productId || undefined,
    name: product?.name || input.name || '',
    quantity,
    unitPricePaise,
    discountPaise,
    taxRatePct,
    subtotalPaise,
    taxPaise,
    totalPaise: subtotalPaise - discountPaise + taxPaise,
  };
}

function totalsOf(items) {
  const sum = (field) => items.reduce((total, item) => total + item[field], 0);
  const subtotalPaise = sum('subtotalPaise');
  const discountPaise = sum('discountPaise');
  const taxPaise = sum('taxPaise');
  return { subtotalPaise, discountPaise, taxPaise, grandTotalPaise: subtotalPaise - discountPaise + taxPaise };
}

function serializeQuotation(quotation) {
  return {
    id: quotation._id,
    number: quotation.number,
    financialYear: quotation.financialYear,
    leadId: quotation.leadId || null,
    contactId: quotation.contactId || null,
    ownerId: quotation.ownerId || null,
    status: quotation.status,
    quotationDate: quotation.quotationDate,
    validUntil: quotation.validUntil || null,
    items: quotation.items,
    totals: quotation.totals,
    legacyNumber: quotation.legacyNumber || '',
    createdAt: quotation.createdAt,
    updatedAt: quotation.updatedAt,
  };
}

async function nextNumber(organizationId, session) {
  const year = financialYear();
  const seq = await nextSequence(organizationId, `quotation:${year}`, { session });
  return { number: `QT/${year}/${String(seq).padStart(4, '0')}`, financialYear: year };
}

async function buildItems(req, items, session) {
  const ids = items.map((item) => item.productId).filter(Boolean);
  const products = await Product.find({ _id: { $in: ids }, organizationId: req.tenant.organizationId }).session(session || null);
  const byId = new Map(products.map((product) => [String(product._id), product]));
  return items.map((item) => {
    if (item.productId && !byId.has(String(item.productId))) {
      throw httpError(400, 'VALIDATION_ERROR', 'Unknown product in the quotation.', [{ field: 'items', code: 'INVALID_PRODUCT', message: 'Pick products from your catalog.' }]);
    }
    return computeItem(item, byId.get(String(item.productId)));
  });
}

// POST /leads/:id/quotations — creates the lead's draft quotation, or updates it if one exists.
async function saveDraftForLead(req, leadId, { items, validUntil }) {
  let result;
  await mongoose.connection.transaction(async (session) => {
    const lead = await leadService.findVisible(req, leadId, session);
    const computed = await buildItems(req, items, session);
    let quotation = await Quotation.findOne({ organizationId: lead.organizationId, leadId: lead._id, status: 'Draft' }).session(session);
    const action = quotation ? 'updated' : 'created';
    if (!quotation) {
      quotation = new Quotation({
        organizationId: lead.organizationId,
        leadId: lead._id,
        contactId: lead.contactId,
        ownerId: lead.ownerId,
        ...(await nextNumber(lead.organizationId, session)),
        createdById: req.user._id,
      });
    }
    quotation.items = computed;
    quotation.totals = totalsOf(computed);
    if (validUntil !== undefined) quotation.validUntil = validUntil;
    await quotation.save({ session });
    await leadService.addActivity(req, lead, `Quotation ${action}`, `Quotation ${action}: ${quotation.number}`, { session });
    result = { quotation, action };
  });
  await audit(req, { action: `quotation.${result.action}`, entityType: 'Quotation', entityId: result.quotation._id });
  return { ...serializeQuotation(result.quotation), action: result.action };
}

const scope = (req) => ({ organizationId: req.tenant.organizationId, ...visibilityFilter(req, MODULES) });

async function findVisible(req, id) {
  const quotation = await Quotation.findOne({ _id: id, ...scope(req) });
  if (!quotation) throw httpError(404, 'NOT_FOUND', 'Quotation not found');
  return quotation;
}

async function list(req, query) {
  const filter = {
    ...scope(req),
    ...(query.leadId && { leadId: query.leadId }),
    ...(query.contactId && { contactId: query.contactId }),
    ...(query.status && { status: query.status }),
  };
  const page = toPage(query);
  const [items, total] = await Promise.all([
    Quotation.find(filter).sort({ createdAt: -1, _id: -1 }).skip(page.skip).limit(page.limit),
    Quotation.countDocuments(filter),
  ]);
  return { items: items.map(serializeQuotation), pagination: paginationMeta(page, total) };
}

async function updateStatus(req, id, { status }) {
  const quotation = await findVisible(req, id);
  quotation.status = status;
  await quotation.save();
  await audit(req, { action: 'quotation.status_changed', entityType: 'Quotation', entityId: quotation._id, changes: { status } });
  return serializeQuotation(quotation);
}

async function remove(req, id) {
  const quotation = await findVisible(req, id);
  await quotation.softDelete();
  await audit(req, { action: 'quotation.deleted', entityType: 'Quotation', entityId: quotation._id });
}

module.exports = {
  saveDraftForLead, list, updateStatus, remove, computeItem, totalsOf, nextNumber, serializeQuotation,
  get: async (req, id) => serializeQuotation(await findVisible(req, id)),
};
