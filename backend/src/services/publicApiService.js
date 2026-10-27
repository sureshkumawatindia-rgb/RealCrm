const crypto = require('crypto');
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Quotation = require('../models/Quotation');
const Order = require('../models/Order');
const Product = require('../models/Product');
const MessageTemplate = require('../models/MessageTemplate');
const Organization = require('../models/Organization');
const httpError = require('../utils/httpError');
const { toPage, paginationMeta } = require('../utils/pagination');
const { normalizePhone } = require('../utils/phone');
const { API_SCOPES } = require('../constants/api');
const contactService = require('./contactService');
const leadService = require('./leadService');
const customFieldService = require('./customFieldService');
const customFieldFilters = require('./customFieldFilters');
const CustomFieldDefinition = require('../models/CustomFieldDefinition');
const { escapeRegex } = require('../utils/listQuery');
const CustomObjectDefinition = require('../models/CustomObjectDefinition');
const CustomRecord = require('../models/CustomRecord');
const customRecordService = require('./customRecordService');
// A quotation's approval (D77) as webhooks carry it (D78); it lives with the rules.
const { publicApproval } = require('./approvalService');
const leadIntake = require('./leadIntakeService');
const conversationService = require('./conversationService');
const templateService = require('./templateService');
const accountService = require('./whatsappAccountService');
const { paymentStatusOf, duePaise } = require('./orderService');

// The public REST API (Phase 10C) at /api/public/v1, for the company's own systems, Zapier and
// Make. Its JSON is a stable public shape (not the CRM's internal one), amounts in paise, times
// in ISO 8601 UTC. Lists: ?page=&limit= (max 100), newest first, or ?updatedSince=<time>
// oldest first (for polling). Writes go through the CRM's own services, with their checks.
const ref = (doc) => (doc?._id ? String(doc._id) : doc ? String(doc) : null);

// The company's own fields (D74): fields = customFieldShapes(organizationId), the active fields of
// contacts and of leads. customFields is { key: value }, a dropdown as its choice's name.
async function customFieldShapes(organizationId) {
  const fields = await CustomFieldDefinition.find({ organizationId, status: 'active' }).sort({ order: 1 }).lean();
  return { contact: fields.filter((f) => f.object === 'contact'), lead: fields.filter((f) => f.object === 'lead') };
}

// The active fields of one of the company's own objects (D78).
const recordFieldsOf = (organizationId, object) => CustomFieldDefinition.find({ organizationId, object, status: 'active' }).sort({ order: 1 }).lean();
const publicField = (f) => ({
  key: f.key, label: f.label, type: f.type, required: Boolean(f.required), helpText: f.helpText || '',
  options: f.type === 'dropdown' ? f.options.filter((o) => !o.archived).map((o) => ({ value: o.value, label: o.label })) : [],
  ...(f.type === 'lookup' && { lookupTarget: f.lookupTarget }),
});

// A record of the company's own objects (D78): a link field's value is the linked record's id.
const publicRecord = (r, fields) => ({
  id: String(r._id), object: r.object, name: r.name, contactId: ref(r.contactId), ownerId: ref(r.ownerId),
  customFields: customFieldService.publicValues(r.customFields, fields),
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

const publicContact = (c, fields) => ({
  id: String(c._id), name: c.name || '', phone: c.phoneE164 || '', email: c.email || '', company: c.company || '',
  gstin: c.gstin || '', city: c.city || '', state: c.state || '', address: c.address || '', tags: c.tags || [],
  source: c.source || '', lifecycle: c.lifecycle || '', marketingConsent: c.consent?.marketing || 'unknown',
  customFields: customFieldService.publicValues(c.customFields, fields?.contact),
  createdAt: c.createdAt, updatedAt: c.updatedAt,
});

const contactBrief = (c, fields) => (c?._id ? {
  id: String(c._id), name: c.name || '', phone: c.phoneE164 || '', email: c.email || '', company: c.company || '',
  customFields: customFieldService.publicValues(c.customFields, fields?.contact),
} : null);

const publicLead = (l, fields) => ({
  id: String(l._id), title: l.title || '', stage: l.stage, lostReason: l.lostReason || '', source: l.source || '',
  contactId: ref(l.contactId), contact: contactBrief(l.contactId, fields), ownerId: ref(l.ownerId),
  expectedValuePaise: l.expectedValuePaise ?? null, probability: l.probability ?? null, quantity: l.quantity ?? null,
  notes: l.notes || '', stageChangedAt: l.stageChangedAt || null,
  customFields: customFieldService.publicValues(l.customFields, fields?.lead),
  createdAt: l.createdAt, updatedAt: l.updatedAt,
});

const publicItem = (i) => ({
  productId: ref(i.productId), name: i.name, hsnSac: i.hsnSac || '', unit: i.unit || '', quantity: i.quantity,
  unitPricePaise: i.unitPricePaise, gstRatePct: i.gstRatePct, taxablePaise: i.taxablePaise, taxPaise: i.taxPaise, totalPaise: i.totalPaise,
});

const publicQuotation = (q) => ({
  id: String(q._id), number: q.number, type: q.type, status: q.status, revision: q.revision || 0,
  contactId: ref(q.contactId), leadId: ref(q.leadId), billTo: { name: q.billTo?.name || '', gstin: q.billTo?.gstin || '' },
  items: (q.items || []).map(publicItem),
  taxablePaise: q.totals?.taxablePaise || 0, taxPaise: q.totals?.taxPaise || 0, totalPaise: q.totals?.grandTotalPaise || 0,
  quotationDate: q.quotationDate || null, validUntil: q.validUntil || null, sentAt: q.sentAt || null, acceptedAt: q.acceptedAt || null,
  createdAt: q.createdAt, updatedAt: q.updatedAt,
});

const publicOrder = (o) => ({
  id: String(o._id), number: o.number, stage: o.stage, source: o.source || 'quotation',
  contactId: ref(o.contactId), leadId: ref(o.leadId), quotationId: ref(o.quotationId),
  items: (o.items || []).map(publicItem), totalPaise: o.totals?.grandTotalPaise || 0,
  paymentStatus: paymentStatusOf(o), amountPaidPaise: o.amountPaidPaise || 0, duePaise: duePaise(o),
  payments: (o.payments || []).map((p) => ({ amountPaise: p.amountPaise, method: p.method || '', source: p.source, reference: p.reference || '', paidAt: p.paidAt })),
  createdAt: o.createdAt, updatedAt: o.updatedAt,
});

const publicProduct = (p) => ({
  id: String(p._id), name: p.name, sku: p.sku || '', category: p.category || '', unit: p.unit || '', hsnSac: p.hsnSac || '',
  pricePaise: p.pricePaise || 0, gstRatePct: p.gstRatePct || 0, active: p.active !== false, createdAt: p.createdAt, updatedAt: p.updatedAt,
});

// --- lists -------------------------------------------------------------------------------------------
async function page(Model, filter, query, serialize, populate) {
  const pageQuery = toPage(query);
  const since = query.updatedSince ? new Date(query.updatedSince) : null;
  const full = { ...filter, ...(since && { updatedAt: { $gt: since } }) };
  let cursor = Model.find(full).sort(since ? { updatedAt: 1, _id: 1 } : { createdAt: -1, _id: -1 }).skip(pageQuery.skip).limit(pageQuery.limit);
  if (populate) cursor = cursor.populate(populate);
  const [items, total] = await Promise.all([cursor, Model.countDocuments(full)]);
  return { items: items.map(serialize), pagination: paginationMeta(pageQuery, total) };
}

async function one(Model, req, id, serialize, populate) {
  if (!mongoose.isValidObjectId(id)) throw httpError(404, 'NOT_FOUND', 'Not found');
  // Private numbers (D61) are for the owners' eyes only, never for other software.
  let query = Model.findOne({ _id: id, organizationId: req.tenant.organizationId, private: { $ne: true } });
  if (populate) query = query.populate(populate);
  const doc = await query;
  if (!doc) throw httpError(404, 'NOT_FOUND', 'Not found');
  return serialize(doc);
}

const CONTACT_FIELDS = 'name phoneE164 email company customFields';
// Serializers with the company's fields (D74), and the cf filters as extra conditions.
const withFields = async (req, serialize) => {
  const fields = await customFieldShapes(req.tenant.organizationId);
  return (doc) => serialize(doc, fields);
};
const fieldFilters = async (req, object, cf) => {
  const conditions = await customFieldFilters.conditions(req, object, cf);
  return conditions.length ? { $and: conditions } : {};
};
const org = (req) => req.tenant.organizationId;

// An active object of the company, or 404 (an archived one is hidden with its records, D75).
async function activeObject(req, key) {
  const object = await CustomObjectDefinition.findOne({ organizationId: org(req), key, status: 'active' }).lean();
  if (!object) throw httpError(404, 'NOT_FOUND', 'Object not found');
  return object;
}
async function oneRecord(req, id) {
  const record = mongoose.isValidObjectId(id) ? await CustomRecord.findOne({ _id: id, organizationId: org(req) }) : null;
  if (!record) throw httpError(404, 'NOT_FOUND', 'Record not found');
  await activeObject(req, record.object);
  return publicRecord(record, await recordFieldsOf(org(req), record.object));
}

function contactFilter(req, { search, phone, email }) {
  const filter = { organizationId: org(req), private: { $ne: true } };
  if (phone) filter.phoneE164 = normalizePhone(phone) || '-';
  if (email) filter.email = String(email).toLowerCase();
  if (search) {
    const pattern = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: pattern }, { company: pattern }, { email: pattern }, { phoneE164: pattern }];
  }
  return filter;
}

module.exports = {
  // GET /me — the company and the key.
  async me(req) {
    const organization = await Organization.findById(org(req)).select('name');
    return { organization: { id: String(organization._id), name: organization.name }, key: { name: req.apiKey.name, scopes: req.apiKey.scopes.map((scope) => ({ scope, label: API_SCOPES[scope] })) } };
  },

  // GET /custom-fields?object=contact|lead — the company's own fields (D74), active ones only.
  async listCustomFields(req, { object }) {
    const fields = (await customFieldShapes(org(req)))[object];
    return fields.map((f) => ({
      key: f.key, label: f.label, type: f.type, required: Boolean(f.required), helpText: f.helpText || '',
      options: f.type === 'dropdown' ? f.options.filter((o) => !o.archived).map((o) => ({ value: o.value, label: o.label })) : [],
    }));
  },

  // GET /objects — the company's own objects (D78) with their active fields.
  async listObjects(req) {
    const objects = await CustomObjectDefinition.find({ organizationId: org(req), status: 'active' }).sort({ order: 1, createdAt: 1 }).lean();
    const fields = await CustomFieldDefinition.find({ organizationId: org(req), object: { $in: objects.map((o) => o.key) }, status: 'active' }).sort({ order: 1 }).lean();
    return objects.map((o) => ({ key: o.key, singular: o.singular, plural: o.plural, fields: fields.filter((f) => f.object === o.key).map(publicField) }));
  },

  // GET /records?object= — one object's records: search (the name and text fields), cf filters,
  // pages or updatedSince, like the other lists.
  async listRecords(req, query) {
    await activeObject(req, query.object);
    const filter = { organizationId: org(req), object: query.object, ...(await fieldFilters(req, query.object, query.cf)) };
    const term = String(query.search || '').trim();
    if (term) {
      const extra = await customFieldFilters.searchClauses(req, query.object, term);
      filter.$or = [{ name: new RegExp(escapeRegex(term.slice(0, 100)), 'i') }, ...extra];
    }
    const fields = await recordFieldsOf(org(req), query.object);
    return page(CustomRecord, filter, query, (r) => publicRecord(r, fields));
  },
  getRecord: (req, id) => oneRecord(req, id),
  // Checked like the CRM's own form (links stay inside the company and must point to the right
  // kind of record); a required field never stops the API (D73).
  async createRecord(req, body) {
    await activeObject(req, body.object);
    const customFields = await customFieldService.fromPublicValues(req, body.object, body.customFields);
    const record = await customRecordService.createDoc(req, { ...body, customFields }, { enforceRequired: false });
    return oneRecord(req, record._id);
  },
  async updateRecord(req, id, body) {
    const current = await oneRecord(req, id);
    const customFields = await customFieldService.fromPublicValues(req, current.object, body.customFields);
    await customRecordService.updateDoc(req, id, { ...body, ...(body.customFields !== undefined && { customFields }) }, { enforceRequired: false });
    return oneRecord(req, id);
  },

  listContacts: async (req, query) => page(Contact, { ...contactFilter(req, query), ...(await fieldFilters(req, 'contact', query.cf)) }, query, await withFields(req, publicContact)),
  getContact: async (req, id) => one(Contact, req, id, await withFields(req, publicContact)),
  // customFields as in the CRM, a dropdown by its choice's name or value; a required field never
  // stops the API (D73).
  async createContact(req, body) {
    const customFields = await customFieldService.fromPublicValues(req, 'contact', body.customFields);
    const created = await contactService.create(req, { ...body, customFields, source: 'API' }, { enforceRequired: false });
    return one(Contact, req, created.id, await withFields(req, publicContact));
  },
  async updateContact(req, id, body) {
    const serialize = await withFields(req, publicContact);
    await one(Contact, req, id, serialize);
    const customFields = await customFieldService.fromPublicValues(req, 'contact', body.customFields);
    await contactService.update(req, id, { ...body, customFields }, { enforceRequired: false });
    return one(Contact, req, id, serialize);
  },

  listLeads: async (req, query) => page(Lead, { organizationId: org(req), private: { $ne: true }, ...(query.stage && { stage: query.stage }), ...(query.source && { source: query.source }), ...(await fieldFilters(req, 'lead', query.cf)) }, query, await withFields(req, publicLead), { path: 'contactId', select: CONTACT_FIELDS }),
  getLead: async (req, id) => one(Lead, req, id, await withFields(req, publicLead), { path: 'contactId', select: CONTACT_FIELDS }),

  // POST /leads — an enquiry, like a lead source: the same customer's open lead gets it, else a
  // new lead; assignment and auto-reply rules run; externalId makes a repeat harmless.
  // customFields (D99): the lead's own fields, checked like the CRM's form before anything is
  // saved (a required field never stops the API); they go on the lead that gets the enquiry.
  async createLead(req, body) {
    const input = await customFieldService.fromPublicValues(req, 'lead', body.customFields);
    const customFields = input ? await customFieldService.applyValues(req, 'lead', input, undefined, { enforceRequired: false }) : undefined;
    const result = await leadIntake.intake({
      organizationId: org(req), source: 'API', sourceRef: body.externalId || `api-${crypto.randomUUID()}`,
      person: body.contact, enquiry: { product: body.product || body.title, quantity: body.quantity, message: body.message }, raw: body,
      touch: { utm: body.utm, referrer: body.referrer, landingPage: body.landingPage }, // D79
      customFields,
    });
    if (result.outcome === 'rejected') throw httpError(400, 'VALIDATION_ERROR', 'A lead needs a valid mobile number or email.', [{ field: 'contact.phone', message: 'Give a valid mobile number or email.' }]);
    const lead = await one(Lead, req, result.leadId, await withFields(req, publicLead), { path: 'contactId', select: CONTACT_FIELDS });
    return { outcome: result.outcome, lead };
  },
  // PATCH /leads/:id (D99): its title, value, quantity, expected close date, notes and own fields
  // (only the fields sent change; empty clears one; a required field never stops the API).
  async updateLead(req, id, body) {
    const serialize = await withFields(req, publicLead);
    await one(Lead, req, id, serialize);
    const customFields = await customFieldService.fromPublicValues(req, 'lead', body.customFields);
    await leadService.update(req, id, { ...body, ...(body.customFields !== undefined && { customFields }) }, { source: 'api', enforceRequired: false });
    return one(Lead, req, id, serialize, { path: 'contactId', select: CONTACT_FIELDS });
  },
  async changeLeadStage(req, id, body) {
    const serialize = await withFields(req, publicLead);
    await one(Lead, req, id, serialize);
    await leadService.changeStage(req, id, body);
    return one(Lead, req, id, serialize, { path: 'contactId', select: CONTACT_FIELDS });
  },

  listQuotations: (req, query) => page(Quotation, { organizationId: org(req), ...(query.status && { status: query.status }), ...(query.contactId && { contactId: query.contactId }) }, query, publicQuotation),
  getQuotation: (req, id) => one(Quotation, req, id, publicQuotation),
  listOrders: (req, query) => page(Order, { organizationId: org(req), ...(query.stage && { stage: query.stage }), ...(query.contactId && { contactId: query.contactId }) }, query, publicOrder),
  getOrder: (req, id) => one(Order, req, id, publicOrder),
  listProducts: (req, query) => page(Product, { organizationId: org(req), ...(query.active !== undefined && { active: query.active }) }, query, publicProduct),

  // POST /messages — an approved WhatsApp template to a customer (by id or mobile number; a new
  // number becomes a customer). Sent from the company's default WhatsApp number.
  async sendTemplate(req, { contactId, phone, name, template: { name: templateName, language }, variables = {} }) {
    let contact;
    if (contactId) {
      contact = mongoose.isValidObjectId(contactId) ? await Contact.findOne({ _id: contactId, organizationId: org(req), private: { $ne: true } }) : null;
      if (!contact) throw httpError(404, 'NOT_FOUND', 'Customer not found');
    } else {
      contact = await contactService.findOrCreate(req, { name: name || phone, phone, source: 'API' }, { source: 'API' });
    }
    if (!contact.phoneE164) throw httpError(409, 'NO_PHONE', 'This customer has no WhatsApp number.');
    if (contact.consent?.marketing === 'opted_out') throw httpError(409, 'OPTED_OUT', 'This customer has opted out of WhatsApp messages.');
    const account = await accountService.defaultAccount(org(req));
    if (!account) throw httpError(409, 'NO_WHATSAPP_NUMBER', 'Connect a WhatsApp number in Settings → WhatsApp first.');
    const template = await MessageTemplate.findOne({ organizationId: org(req), whatsappAccountId: account._id, name: templateName, ...(language && { language }) }).sort({ updatedAt: -1 });
    if (!template) throw httpError(404, 'TEMPLATE_NOT_FOUND', `No template "${templateName}"${language ? ` (${language})` : ''} on the default WhatsApp number.`);
    const shape = templateService.shapeOf(template);
    if (template.status !== 'APPROVED' || !shape.sendable) throw httpError(409, 'TEMPLATE_NOT_SENDABLE', `The template "${templateName}" cannot be sent${shape.notSendableReason ? `: ${shape.notSendableReason}` : ' (it is not approved yet)'}.`);
    const conversation = await conversationService.ensureConversation({ organizationId: org(req), contactId: contact._id, accountId: account._id });
    const values = Object.fromEntries(Object.entries(variables).map(([part, map]) => [part, Object.fromEntries(Object.entries(map || {}).map(([k, v]) => [k, String(v)]))]));
    const message = await conversationService.sendTemplateAutomatically({ conversation, template, variables: values, automation: { kind: 'api' } });
    return { messageId: ref(message?.id || message?._id), status: message?.status || 'queued', contactId: String(contact._id), conversationId: String(conversation._id) };
  },

  publicContact, publicLead, publicQuotation, publicOrder, publicProduct, customFieldShapes, publicRecord, recordFieldsOf, publicApproval,
};
