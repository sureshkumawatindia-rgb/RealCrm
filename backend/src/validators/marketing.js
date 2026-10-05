const Joi = require('joi');
const { objectId } = require('./common');
const { LEAD_SOURCES, LEAD_STAGES, CONTACT_LIFECYCLES } = require('../constants/crm');

// Segments and contact imports (Phase 7).
const words = (max = 50) => Joi.array().items(Joi.string().trim().min(1).max(max)).max(50).unique();

const filters = Joi.object({
  tagsAll: words(),
  tagsAny: words(),
  tagsNone: words(),
  states: words(100),
  cities: words(100),
  sources: Joi.array().items(Joi.string().valid(...LEAD_SOURCES)).max(LEAD_SOURCES.length).unique(),
  lifecycles: Joi.array().items(Joi.string().valid(...CONTACT_LIFECYCLES)).max(CONTACT_LIFECYCLES.length).unique(),
  ownerIds: Joi.array().items(objectId).max(100).unique(),
  productIds: Joi.array().items(objectId).max(100).unique(),
  productCategories: words(100),
  leadStages: Joi.array().items(Joi.string().valid(...LEAD_STAGES)).max(LEAD_STAGES.length).unique(),
  consent: Joi.string().valid('not_opted_out', 'opted_in').default('not_opted_out'),
});

const segmentFields = {
  name: Joi.string().trim().min(1).max(100),
  description: Joi.string().trim().max(500).allow(''),
  filters,
};

// The import form arrives as multipart fields (strings); mapping is a JSON list, one field per column.
const contactImport = Joi.object({
  mapping: Joi.array().items(Joi.string().valid('', 'name', 'phone', 'email', 'company', 'gstin', 'state', 'city', 'address', 'tags', 'source', 'notes')).min(1).max(200).required(),
  tags: words(),
  consent: Joi.string().valid('unknown', 'opted_in').default('unknown'),
  lifecycle: Joi.string().valid(...CONTACT_LIFECYCLES).default('customer'),
  updateExisting: Joi.boolean().default(true),
  dryRun: Joi.boolean().default(false),
});

module.exports = {
  segmentCreate: Joi.object({ ...segmentFields, name: segmentFields.name.required(), filters: filters.default({}) }),
  segmentPatch: Joi.object(segmentFields).min(1),
  segmentPreview: Joi.object({ filters: filters.default({}) }),
  contactImport,
};
