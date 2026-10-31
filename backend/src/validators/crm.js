const Joi = require('joi');
const { objectId } = require('./common');
const { paginationQuery } = require('../utils/pagination');
const { GSTIN_PATTERN } = require('../utils/gstin');
const {
  LEAD_STAGES, LEAD_SOURCES, CONTACT_LIFECYCLES, CONTACT_STATUSES,
  TASK_STATUSES, TASK_PRIORITIES, TASK_ORIGINS, EVENT_TYPES, RELATED_TYPES,
  TICKET_STATUSES, TICKET_PRIORITIES, TICKET_CATEGORIES, DOCUMENT_CATEGORIES,
  CAMPAIGN_TYPES, CAMPAIGN_STATUSES, LEAD_IMPORT_FIELDS,
} = require('../constants/crm');
// Ticket SLA (D107): minutes, from 5 minutes to 90 days; the first reply cannot be due after the
// resolution.
const slaMinutes = Joi.number().integer().min(5).max(90 * 1440);
const slaLimit = Joi.object({ reply: slaMinutes.required(), resolve: slaMinutes.required() })
  .custom((value, helpers) => (value.reply <= value.resolve ? value : helpers.message('The first reply cannot be due after the resolution')));
// The company's own fields (D73, D74): values on records, and ?cf= filters on the lists.
const { fieldFilters, customFieldValues } = require('./customFields');

const text = (max) => Joi.string().trim().max(max).allow('');
// null clears the reference (e.g. "no product").
const optionalId = objectId.allow(null);
const paise = Joi.number().integer().min(0).max(1e13);
const listBase = { ...paginationQuery, q: Joi.string().trim().max(100).allow(''), sort: Joi.string().max(40) };

const contactFields = {
  name: Joi.string().trim().min(1).max(200),
  email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254).allow(''),
  phone: text(30),
  company: text(200),
  gstin: Joi.string().trim().uppercase().pattern(GSTIN_PATTERN).allow('')
    .messages({ 'string.pattern.base': 'GSTIN must be 15 characters, for example 08ABCDE1234F1Z5' }),
  state: text(100),
  city: text(100),
  address: text(500),
  tags: Joi.array().items(Joi.string().trim().max(50)).max(30).unique(),
  source: Joi.string().valid(...LEAD_SOURCES),
  lifecycle: Joi.string().valid(...CONTACT_LIFECYCLES),
  status: Joi.string().valid(...CONTACT_STATUSES),
  productIds: Joi.array().items(objectId).max(20).unique(),
  notes: text(5000),
  ownerId: objectId.allow(null),
  // WhatsApp offers (Phase 7, D35): broadcasts never go to "opted_out".
  marketingConsent: Joi.string().valid('unknown', 'opted_in', 'opted_out'),
  customFields: customFieldValues,
};

const noteEntry = Joi.object({
  id: Joi.string().trim().max(60).required(),
  title: text(200),
  text: text(5000),
  createdAt: Joi.date(),
});

const leadFields = {
  title: text(200),
  stage: Joi.string().valid(...LEAD_STAGES),
  lostReason: text(500),
  source: Joi.string().valid(...LEAD_SOURCES),
  productId: optionalId,
  quantity: Joi.number().min(0).max(1e9).allow(null),
  expectedValuePaise: paise.allow(null),
  expectedCloseDate: Joi.date().allow(null, '').empty(''),
  followUpAt: Joi.date().allow(null, '').empty(''),
  ownerId: objectId.allow(null),
  notes: text(5000),
  noteEntries: Joi.array().items(noteEntry).max(200),
  customFields: customFieldValues,
};

const calendarDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).messages({ 'string.pattern.base': 'Use a date like 2026-10-05' });
const clockTime = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).allow('').messages({ 'string.pattern.base': 'Use a time like 14:30' });
const related = {
  relatedType: Joi.string().valid(...RELATED_TYPES),
  relatedId: objectId.allow(null),
  relatedName: text(200),
  assigneeId: objectId.allow(null),
};

const taskFields = {
  title: Joi.string().trim().min(1).max(300),
  description: text(5000),
  dueDate: calendarDate.allow(''),
  priority: Joi.string().valid(...TASK_PRIORITIES),
  status: Joi.string().valid(...TASK_STATUSES),
  origin: Joi.string().valid(...TASK_ORIGINS),
  ...related,
};

const eventFields = {
  title: Joi.string().trim().min(1).max(300),
  type: Joi.string().valid(...EVENT_TYPES),
  date: calendarDate,
  startTime: clockTime,
  endTime: clockTime,
  description: text(5000),
  ...related,
};

const ticketFields = {
  subject: Joi.string().trim().min(1).max(300),
  description: text(5000),
  contactId: objectId.allow(null),
  customerName: text(200),
  category: Joi.string().valid(...TICKET_CATEGORIES),
  priority: Joi.string().valid(...TICKET_PRIORITIES),
  status: Joi.string().valid(...TICKET_STATUSES),
  dueDate: calendarDate.allow(''),
  assigneeId: objectId.allow(null),
};

// Documents arrive as multipart form fields (all strings), so empty strings mean "none".
const documentFields = {
  name: Joi.string().trim().min(1).max(300),
  description: text(5000),
  category: Joi.string().valid(...DOCUMENT_CATEGORIES),
  ownerId: objectId.allow(null, ''),
  tags: Joi.alternatives(Joi.array().items(Joi.string().trim().max(40).allow('')).max(50), Joi.string().max(2000).allow('')),
  linkUrl: Joi.string().trim().max(2000).uri({ scheme: ['http', 'https'] }).allow('')
    .messages({ 'string.uri': 'Use a web address like https://example.com', 'string.uriCustomScheme': 'Use a web address starting with https:// or http://' }),
  relatedType: Joi.string().valid(...RELATED_TYPES),
  relatedId: objectId.allow(null, ''),
  relatedName: text(200),
};

const campaignFields = {
  name: Joi.string().trim().min(1).max(200),
  type: Joi.string().valid(...CAMPAIGN_TYPES),
  status: Joi.string().valid(...CAMPAIGN_STATUSES),
  startDate: calendarDate.allow(''),
  endDate: calendarDate.allow(''),
  budgetPaise: paise,
  leadsGenerated: Joi.number().integer().min(0).max(1e9),
  audience: text(300),
  description: text(5000),
  ownerId: optionalId,
};

const leadContact = {
  name: Joi.string().trim().min(1).max(200),
  email: contactFields.email,
  phone: contactFields.phone,
  company: contactFields.company,
};

module.exports = {
  contactCreate: Joi.object({ ...contactFields, name: contactFields.name.required() }),
  contactPatch: Joi.object(contactFields).min(1),
  contactList: Joi.object({
    ...listBase,
    lifecycle: Joi.string().valid(...CONTACT_LIFECYCLES),
    status: Joi.string().valid(...CONTACT_STATUSES),
    ownerId: objectId,
    tag: Joi.string().trim().max(50),
    consent: Joi.string().valid('unknown', 'opted_in', 'opted_out'),
    cf: fieldFilters,
  }),

  productCreate: Joi.object({
    name: Joi.string().trim().min(1).max(200).required(),
    sku: text(100),
    category: text(100),
    description: text(2000),
    unit: text(20),
    hsnSac: Joi.string().trim().pattern(/^\d{4,8}$/).allow('')
      .messages({ 'string.pattern.base': 'HSN/SAC code must be 4 to 8 digits' }),
    pricePaise: paise,
    gstRatePct: Joi.number().min(0).max(100),
    moq: Joi.number().integer().min(0).allow(null),
    stockQty: Joi.number().integer().min(0).allow(null),
    images: Joi.array().items(Joi.string().uri({ scheme: ['http', 'https'] })).max(10),
    active: Joi.boolean(),
    inCatalog: Joi.boolean(), // shown in the WhatsApp catalog (Phase 8C)
  }),
  productList: Joi.object({ ...listBase, category: Joi.string().trim().max(100), active: Joi.boolean() }),

  // G1 (D105): the leads import form arrives as multipart fields (strings); mapping is a JSON
  // list, one target per column: a lead field, "cf:<key>" for the company's own lead fields, or ''.
  leadImport: Joi.object({
    mapping: Joi.array().items(Joi.alternatives().try(
      Joi.string().valid('', ...LEAD_IMPORT_FIELDS),
      Joi.string().pattern(/^cf:[a-z][a-z0-9_]{1,39}$/),
    )).min(1).max(200).required(),
    pipelineId: objectId.allow(''),
    ownerFallback: Joi.string().valid('me', 'none').default('me'),
    openLeads: Joi.string().valid('skip', 'add').default('skip'),
    tags: Joi.array().items(Joi.string().trim().min(1).max(50)).max(20).default([]),
    runAutomations: Joi.boolean().default(false),
    dryRun: Joi.boolean().default(false),
  }),
  leadCreate: Joi.object({
    ...leadFields,
    pipelineId: objectId, // D84: else the default pipeline
    contactId: objectId,
    contact: Joi.object({ ...leadContact, name: leadContact.name.required() }),
  }).xor('contactId', 'contact'),
  leadPatch: Joi.object({ ...leadFields, contact: Joi.object(leadContact).min(1), version: Joi.number().integer().min(0) }).min(1),
  // A fixed stage, or (D84) a stage of a pipeline / another pipeline; not both.
  leadStage: Joi.object({
    stage: Joi.string().valid(...LEAD_STAGES),
    pipelineStageId: objectId,
    pipelineId: objectId,
    lostReason: text(500),
    version: Joi.number().integer().min(0),
  }).or('stage', 'pipelineStageId', 'pipelineId').nand('stage', 'pipelineStageId').nand('stage', 'pipelineId'),
  leadList: Joi.object({
    ...listBase,
    stage: Joi.string().valid(...LEAD_STAGES),
    ownerId: objectId,
    productId: objectId,
    contactId: objectId,
    followUpFrom: Joi.date(),
    followUpTo: Joi.date(),
    cf: fieldFilters,
  }),
  // Download Excel (D82): the list's own filters, and the file type.
  contactExport: Joi.object({ ...listBase, lifecycle: Joi.string().valid(...CONTACT_LIFECYCLES), status: Joi.string().valid(...CONTACT_STATUSES), ownerId: objectId, tag: Joi.string().trim().max(50), consent: Joi.string().valid('unknown', 'opted_in', 'opted_out'), cf: fieldFilters, format: Joi.string().valid('xlsx', 'csv').default('xlsx') }),
  leadExport: Joi.object({ ...listBase, stage: Joi.string().valid(...LEAD_STAGES), ownerId: objectId, productId: objectId, contactId: objectId, followUpFrom: Joi.date(), followUpTo: Joi.date(), cf: fieldFilters, format: Joi.string().valid('xlsx', 'csv').default('xlsx') }),
  // The rows ticked in the Leads or Customers list (D100).
  selectedExport: Joi.object({ ids: Joi.array().items(objectId).min(1).max(5000).unique().required(), format: Joi.string().valid('xlsx', 'csv').default('xlsx') }),
  // Merging two customers (D100): keep says which side each field comes from.
  mergePreview: Joi.object({ with: objectId.required() }),
  contactMerge: Joi.object({
    otherId: objectId.required(),
    keep: Joi.object().pattern(/^(name|email|phone|company|gstin|city|state|address|ownerId|status|cf\.[a-z][a-z0-9_]{1,39})$/, Joi.string().valid('main', 'other')).max(80).default({}),
  }),
  leadNote: Joi.object({ text: Joi.string().trim().min(1).max(5000).required(), type: Joi.string().trim().max(40).default('Note'), mentions: Joi.array().items(objectId).max(10).unique().default([]) }),
  mentionQuery: Joi.object({ q: Joi.string().trim().max(60).allow('') }),

  quotationDraft: Joi.object({
    items: Joi.array().items(Joi.object({
      productId: optionalId,
      name: text(200),
      quantity: Joi.number().greater(0).max(1e9).required(),
      unitPricePaise: paise.required(),
      discountPaise: paise.default(0),
      taxRatePct: Joi.number().min(0).max(100).default(0),
    })).min(1).max(100).required(),
    validUntil: Joi.date().allow(null, '').empty(''),
  }),

  taskCreate: Joi.object({ ...taskFields, title: taskFields.title.required() }),
  taskPatch: Joi.object(taskFields).fork(['origin'], (field) => field.forbidden()).min(1),
  taskList: Joi.object({
    ...listBase,
    status: Joi.string().valid(...TASK_STATUSES),
    priority: Joi.string().valid(...TASK_PRIORITIES),
    origin: Joi.string().valid(...TASK_ORIGINS),
    assigneeId: objectId,
    relatedType: Joi.string().valid(...RELATED_TYPES.filter(Boolean)),
    relatedId: objectId,
    dueFrom: calendarDate,
    dueTo: calendarDate,
  }),

  eventCreate: Joi.object({ ...eventFields, title: eventFields.title.required(), date: eventFields.date.required() }),
  eventPatch: Joi.object(eventFields).min(1),

  ticketCreate: Joi.object({ ...ticketFields, subject: ticketFields.subject.required() }),
  ticketPatch: Joi.object(ticketFields).min(1),
  ticketList: Joi.object({
    ...listBase,
    status: Joi.string().valid(...TICKET_STATUSES),
    priority: Joi.string().valid(...TICKET_PRIORITIES),
    category: Joi.string().valid(...TICKET_CATEGORIES),
    assigneeId: objectId,
    contactId: objectId,
  }),

  ticketSla: Joi.object({
    enabled: Joi.boolean(),
    workingHoursOnly: Joi.boolean(),
    limits: Joi.object(Object.fromEntries(TICKET_PRIORITIES.map((priority) => [priority, slaLimit]))),
  }).min(1),

  noteCreate: Joi.object({ text: Joi.string().trim().min(1).max(5000).required() }),

  campaignCreate: Joi.object({ ...campaignFields, name: campaignFields.name.required() }),
  campaignPatch: Joi.object(campaignFields).min(1),
  campaignList: Joi.object({
    ...listBase,
    type: Joi.string().valid(...CAMPAIGN_TYPES),
    status: Joi.string().valid(...CAMPAIGN_STATUSES),
    ownerId: objectId,
    startFrom: calendarDate,
    startTo: calendarDate,
  }),


  documentCreate: Joi.object({ ...documentFields, name: documentFields.name.required() }),
  // May be empty when only a new file is sent.
  documentPatch: Joi.object(documentFields),
  documentList: Joi.object({
    ...listBase,
    category: Joi.string().valid(...DOCUMENT_CATEGORIES),
    relatedType: Joi.string().valid(...RELATED_TYPES.filter(Boolean)),
    relatedId: objectId,
    ownerId: objectId,
  }),
  eventList: Joi.object({
    ...listBase,
    type: Joi.string().valid(...EVENT_TYPES),
    assigneeId: objectId,
    relatedType: Joi.string().valid(...RELATED_TYPES.filter(Boolean)),
    relatedId: objectId,
    from: calendarDate,
    to: calendarDate,
  }),
};
