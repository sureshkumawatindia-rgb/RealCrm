const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const OrganizationMember = require('../models/OrganizationMember');
const Product = require('../models/Product');
const Segment = require('../models/Segment');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { escapeRegex } = require('../utils/listQuery');

// Saved audiences for broadcasts (Phase 7, owners and admins). A segment is worked out each time
// it is used: every filled-in filter must match; text filters (tags, states, cities, product
// categories) ignore capitals. Opted-out customers are always left out (D35).
const SAMPLE = 10;
const exactly = (values) => values.map((v) => new RegExp(`^${escapeRegex(String(v).trim())}$`, 'i'));
const ids = (values) => values.map((v) => new mongoose.Types.ObjectId(String(v)));

// The Mongo filter on contacts for a segment's filters (without the consent rule when asked,
// so the preview can say how many were left out for having opted out).
async function contactFilter(organizationId, filters = {}, { withConsent = true } = {}) {
  const f = filters;
  const and = [{ organizationId: new mongoose.Types.ObjectId(String(organizationId)) }, { deletedAt: null }];
  if (f.tagsAll?.length) and.push({ tags: { $all: exactly(f.tagsAll) } });
  if (f.tagsAny?.length) and.push({ tags: { $in: exactly(f.tagsAny) } });
  if (f.tagsNone?.length) and.push({ tags: { $nin: exactly(f.tagsNone) } });
  if (f.states?.length) and.push({ state: { $in: exactly(f.states) } });
  if (f.cities?.length) and.push({ city: { $in: exactly(f.cities) } });
  if (f.sources?.length) and.push({ source: { $in: f.sources } });
  if (f.lifecycles?.length) and.push({ lifecycle: { $in: f.lifecycles } });
  if (f.ownerIds?.length) and.push({ ownerId: { $in: ids(f.ownerIds) } });
  and.push({ private: { $ne: true } }); // never a private number (D61)
  if (f.productIds?.length || f.productCategories?.length) {
    const productIds = [
      ...ids(f.productIds || []),
      ...(f.productCategories?.length ? (await Product.find({ organizationId, category: { $in: exactly(f.productCategories) } }).select('_id')).map((p) => p._id) : []),
    ];
    const withLeads = await Lead.distinct('contactId', { organizationId, productId: { $in: productIds } });
    and.push({ $or: [{ productIds: { $in: productIds } }, { _id: { $in: withLeads } }] });
  }
  if (f.leadStages?.length) and.push({ _id: { $in: await Lead.distinct('contactId', { organizationId, stage: { $in: f.leadStages } }) } });
  if (withConsent) and.push(f.consent === 'opted_in' ? { 'consent.marketing': 'opted_in' } : { 'consent.marketing': { $ne: 'opted_out' } });
  return { $and: and };
}

// How many customers a segment reaches now, and a few of them.
async function preview(organizationId, filters) {
  const reach = await contactFilter(organizationId, filters);
  const all = await contactFilter(organizationId, filters, { withConsent: false });
  const [total, withWhatsApp, matchingAll, sample] = await Promise.all([
    Contact.countDocuments(reach),
    Contact.countDocuments({ $and: [reach, { phoneE164: { $type: 'string' } }] }),
    Contact.countDocuments(all),
    Contact.find(reach).sort({ name: 1 }).limit(SAMPLE).select('name phoneE164 phone city state tags'),
  ]);
  return {
    total,
    withWhatsApp,
    optedOut: Math.max(matchingAll - total, 0),
    sample: sample.map((c) => ({ id: c._id, name: c.name, phone: c.phoneE164 || c.phone || '', city: c.city, state: c.state, tags: c.tags })),
  };
}

function serialize(segment) {
  return { id: segment._id, name: segment.name, description: segment.description, filters: segment.filters, createdAt: segment.createdAt, updatedAt: segment.updatedAt };
}

async function find(req, id) {
  const segment = await Segment.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!segment) throw httpError(404, 'NOT_FOUND', 'Segment not found');
  return segment;
}

// Owners and products named in a filter must be this organization's.
async function checkFilters(req, filters = {}) {
  const organizationId = req.tenant.organizationId;
  if (filters.ownerIds?.length && (await OrganizationMember.countDocuments({ _id: { $in: filters.ownerIds }, organizationId })) !== filters.ownerIds.length) {
    throw httpError(400, 'VALIDATION_ERROR', 'Pick owners from your team.', [{ field: 'filters.ownerIds', code: 'INVALID_MEMBER', message: 'Pick owners from your team.' }]);
  }
  if (filters.productIds?.length && (await Product.countDocuments({ _id: { $in: filters.productIds }, organizationId })) !== filters.productIds.length) {
    throw httpError(400, 'VALIDATION_ERROR', 'Pick products from your catalog.', [{ field: 'filters.productIds', code: 'INVALID_PRODUCT', message: 'Pick products from your catalog.' }]);
  }
}

async function list(req) {
  const segments = await Segment.find({ organizationId: req.tenant.organizationId }).sort({ name: 1 });
  return Promise.all(segments.map(async (s) => ({ ...serialize(s), count: await Contact.countDocuments(await contactFilter(req.tenant.organizationId, s.filters)) })));
}

async function create(req, body) {
  await checkFilters(req, body.filters);
  const segment = await Segment.create({ ...body, organizationId: req.tenant.organizationId, createdById: req.user._id });
  await audit(req, { action: 'segment.created', entityType: 'Segment', entityId: segment._id });
  return serialize(segment);
}

async function update(req, id, body) {
  const segment = await find(req, id);
  if (body.filters) await checkFilters(req, body.filters);
  for (const key of ['name', 'description', 'filters']) if (key in body) segment.set(key, body[key]);
  await segment.save();
  await audit(req, { action: 'segment.updated', entityType: 'Segment', entityId: segment._id, changes: Object.keys(body) });
  return serialize(segment);
}

async function remove(req, id) {
  const segment = await find(req, id);
  await segment.deleteOne();
  await audit(req, { action: 'segment.deleted', entityType: 'Segment', entityId: segment._id });
}

// What the segment builder can offer: the tags, places and categories in use.
async function options(req) {
  const organizationId = req.tenant.organizationId;
  const live = { organizationId, deletedAt: null };
  const clean = (values) => [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const [tags, states, cities, categories] = await Promise.all([
    Contact.distinct('tags', live), Contact.distinct('state', live), Contact.distinct('city', live), Product.distinct('category', live),
  ]);
  return { tags: clean(tags), states: clean(states), cities: clean(cities), productCategories: clean(categories) };
}

module.exports = {
  list, create, update, remove, options, contactFilter,
  get: async (req, id) => serialize(await find(req, id)),
  preview: async (req, filters) => {
    await checkFilters(req, filters);
    return preview(req.tenant.organizationId, filters);
  },
  previewSaved: async (req, id) => preview(req.tenant.organizationId, (await find(req, id)).filters),
  find,
};
