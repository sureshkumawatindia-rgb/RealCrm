const Contact = require('../models/Contact');
const tenantRepository = require('../repositories/tenantRepository');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { normalizePhone } = require('../utils/phone');
const { normalizeGstin, stateCodeFromGstin } = require('../utils/gstin');
const { searchFilter, sortSpec } = require('../utils/listQuery');
const { visibilityFilter, privacyFilter, resolveOwnerId, ownerPatch } = require('./access');
const planService = require('./planService');
const automationEvents = require('./automation/events');

const MODULE = 'customers';
const SEARCH_FIELDS = ['name', 'email', 'phone', 'phoneE164', 'company', 'city'];
const SORTS = ['name', 'createdAt', 'updatedAt', 'company'];
const EDITABLE = ['name', 'email', 'phone', 'company', 'gstin', 'state', 'city', 'address', 'tags', 'source', 'lifecycle', 'status', 'productIds', 'notes'];

function serializeContact(contact) {
  return {
    id: contact._id,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    phoneE164: contact.phoneE164 || '',
    company: contact.company,
    gstin: contact.gstin,
    stateCode: contact.stateCode,
    state: contact.state,
    city: contact.city,
    address: contact.address,
    tags: contact.tags,
    source: contact.source,
    ownerId: contact.ownerId || null,
    lifecycle: contact.lifecycle,
    status: contact.status,
    productIds: contact.productIds,
    notes: contact.notes,
    consent: { marketing: contact.consent?.marketing || 'unknown', changedAt: contact.consent?.changedAt || null, method: contact.consent?.method || '' },
    becameCustomerAt: contact.becameCustomerAt || null,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  };
}

const repo = (req) => tenantRepository(Contact, req.tenant.organizationId);

// Validates and normalizes phone/GSTIN; throws 400 for a number that cannot be a phone.
function normalizeFields(data) {
  const out = { ...data };
  if ('phone' in data) {
    const phoneE164 = normalizePhone(data.phone);
    if (phoneE164 === null) {
      throw httpError(400, 'VALIDATION_ERROR', 'Enter a valid phone number.', [{ field: 'phone', code: 'INVALID_PHONE', message: 'Enter a 10-digit mobile number or a number with its country code.' }]);
    }
    out.phoneE164 = phoneE164 || undefined;
  }
  if ('gstin' in data) {
    out.gstin = normalizeGstin(data.gstin);
    out.stateCode = stateCodeFromGstin(out.gstin);
  }
  return out;
}

// marketingConsent from the form or an import: who changed it and when is kept with it.
function consentOf(marketing, method) {
  return { marketing, changedAt: new Date(), method };
}

async function assertPhoneFree(req, phoneE164, exceptId, session) {
  if (!phoneE164) return;
  const existing = await Contact.findOne({ organizationId: req.tenant.organizationId, phoneE164, _id: { $ne: exceptId } }).session(session || null);
  if (existing) {
    throw httpError(409, 'DUPLICATE_CONTACT', `${existing.name} already has this phone number.`, [{ field: 'phone', code: 'DUPLICATE_CONTACT', message: String(existing._id) }]);
  }
}

async function list(req, query) {
  const filter = {
    ...searchFilter(query.q, SEARCH_FIELDS),
    ...visibilityFilter(req, MODULE),
    ...privacyFilter(req),
    ...(query.lifecycle && { lifecycle: query.lifecycle }),
    ...(query.status && { status: query.status }),
    ...(query.ownerId && { ownerId: query.ownerId }),
    ...(query.tag && { tags: query.tag }),
    ...(query.consent && (query.consent === 'unknown' ? { 'consent.marketing': { $nin: ['opted_in', 'opted_out'] } } : { 'consent.marketing': query.consent })),
  };
  const { items, pagination } = await repo(req).paginate(filter, query, { sort: sortSpec(query.sort, SORTS) });
  return { items: items.map(serializeContact), pagination };
}

async function findVisible(req, id, session) {
  const contact = await repo(req).findOne({ _id: id, ...visibilityFilter(req, MODULE), ...privacyFilter(req) }).session(session || null);
  if (!contact) throw httpError(404, 'NOT_FOUND', 'Contact not found');
  return contact;
}

async function create(req, body, { session } = {}) {
  const data = normalizeFields(body);
  await assertPhoneFree(req, data.phoneE164, undefined, session);
  // Contacts added by hand count against the plan; WhatsApp messages and lead sources never stop.
  await planService.assertRoom(req.tenant.organizationId, 'contacts', { action: 'add contacts' });
  const { marketingConsent, ...fields } = data;
  const contact = await repo(req).create({
    ...fields,
    ...(marketingConsent && { consent: consentOf(marketingConsent, 'manual') }),
    ownerId: await resolveOwnerId(req, body.ownerId),
    becameCustomerAt: data.lifecycle === 'customer' ? new Date() : undefined,
    createdById: req.user._id,
  }, { session });
  await audit(req, { action: 'contact.created', entityType: 'Contact', entityId: contact._id });
  automationEvents.emit('contact.created', { organizationId: contact.organizationId, contactId: contact._id, source: contact.source, key: `contact.created:${contact._id}` }, req);
  return contact;
}

// Used by leads: the same phone (or, without a phone, the same email) is the same contact.
async function findOrCreate(req, input, { source = 'Manual', session } = {}) {
  const data = normalizeFields({ ...input, source: input.source || source });
  const organizationId = req.tenant.organizationId;
  let existing = null;
  if (data.phoneE164) existing = await Contact.findOne({ organizationId, phoneE164: data.phoneE164 }).session(session || null);
  else if (data.email) existing = await Contact.findOne({ organizationId, email: data.email.toLowerCase() }).session(session || null);
  if (existing) return existing;
  return create(req, input.source ? input : { ...input, source }, { session });
}

// skipVisibility: the caller already checked access through a related record (a lead the
// member may edit), so the contact itself does not have to be owned by them.
async function update(req, id, patch, { session, skipVisibility = false } = {}) {
  const contact = skipVisibility
    ? await repo(req).findById(id).session(session || null)
    : await findVisible(req, id, session);
  if (!contact) throw httpError(404, 'NOT_FOUND', 'Contact not found');
  const data = normalizeFields(Object.fromEntries(Object.entries(patch).filter(([key]) => EDITABLE.includes(key))));
  if ('phoneE164' in data) await assertPhoneFree(req, data.phoneE164, contact._id, session);
  if (data.lifecycle === 'customer' && contact.lifecycle !== 'customer') contact.becameCustomerAt = new Date();
  Object.assign(contact, data, await ownerPatch(req, patch));
  if (patch.marketingConsent && patch.marketingConsent !== (contact.consent?.marketing || 'unknown')) contact.consent = consentOf(patch.marketingConsent, 'manual');
  if ('phoneE164' in data && !data.phoneE164) contact.phoneE164 = undefined;
  await contact.save({ session });
  await audit(req, { action: 'contact.updated', entityType: 'Contact', entityId: contact._id, changes: Object.keys(data) });
  return contact;
}

async function remove(req, id) {
  const contact = await findVisible(req, id);
  contact.phoneE164 = undefined; // the number may be used by a new contact
  await contact.softDelete();
  await audit(req, { action: 'contact.deleted', entityType: 'Contact', entityId: contact._id });
}

module.exports = {
  list,
  get: async (req, id) => serializeContact(await findVisible(req, id)),
  create: async (req, body) => serializeContact(await create(req, body)),
  update: async (req, id, patch) => serializeContact(await update(req, id, patch)),
  remove,
  findOrCreate,
  consentOf,
  updateContact: update,
  findVisible,
  serializeContact,
  normalizeFields,
};
