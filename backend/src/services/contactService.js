const Contact = require('../models/Contact');
const tenantRepository = require('../repositories/tenantRepository');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { normalizePhone } = require('../utils/phone');
const { normalizeGstin, stateCodeFromGstin } = require('../utils/gstin');
const { searchFilter, sortSpec, MATCH_MAX } = require('../utils/listQuery');
const { visibilityFilter, privacyFilter, resolveOwnerId, ownerPatch } = require('./access');
const planService = require('./planService');
const customFieldService = require('./customFieldService');
const customFieldFilters = require('./customFieldFilters');
const lookupService = require('./lookupService');
const automationEvents = require('./automation/events');
const consentHistory = require('./consentService');

const MODULE = 'customers';
// Tags too (D82), as the Customers page's own search box does, so "Download Excel" has the same rows.
const SEARCH_FIELDS = ['name', 'email', 'phone', 'phoneE164', 'company', 'city', 'tags'];
const SORTS = ['name', 'createdAt', 'updatedAt', 'company'];
const EDITABLE = ['name', 'email', 'phone', 'company', 'gstin', 'state', 'city', 'address', 'tags', 'source', 'lifecycle', 'status', 'productIds', 'notes'];

// keys: the active custom fields (customFieldService.activeKeys); without them, every stored value.
// links: lookupService.linksFor — the names of the records its link fields point to (D75).
// A kept touch (D79), or null when there is none.
const touchOf = (t) => (t?.channel ? { channel: t.channel, source: t.source || '', medium: t.medium || '', campaign: t.campaign || '', at: t.at || null } : null);

function serializeContact(contact, keys, links) {
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
    smsOptOut: contact.smsOptOut?.at ? { at: contact.smsOptOut.at, method: contact.smsOptOut.method || '' } : null,
    becameCustomerAt: contact.becameCustomerAt || null,
    firstTouch: touchOf(contact.firstTouch), // how they first found the company (D79)
    customFields: customFieldService.visibleValues(contact.customFields, keys),
    customFieldLinks: links?.get(String(contact._id)) || {},
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

// The list's filter, also used by "Download Excel" (D82) so the file has what the screen shows.
async function listFilter(req, query) {
  // Search also looks in the company's own text and dropdown fields; cf filters must all match (D74).
  const [extraSearch, fieldFilters] = await Promise.all([
    customFieldFilters.searchClauses(req, 'contact', query.q),
    customFieldFilters.conditions(req, 'contact', query.cf),
  ]);
  const search = searchFilter(query.q, SEARCH_FIELDS);
  const filter = {
    ...(search.$or && { $or: [...search.$or, ...extraSearch] }),
    ...(fieldFilters.length && { $and: fieldFilters }),
    ...visibilityFilter(req, MODULE),
    ...privacyFilter(req),
    ...(query.lifecycle && { lifecycle: query.lifecycle }),
    ...(query.status && { status: query.status }),
    ...(query.ownerId && { ownerId: query.ownerId }),
    ...(query.tag && { tags: query.tag }),
    ...(query.consent && (query.consent === 'unknown' ? { 'consent.marketing': { $nin: ['opted_in', 'opted_out'] } } : { 'consent.marketing': query.consent })),
  };
  return filter;
}

async function list(req, query) {
  const filter = await listFilter(req, query);
  const { items, pagination } = await repo(req).paginate(filter, query, { sort: sortSpec(query.sort, SORTS) });
  const [keys, links] = await Promise.all([customFieldService.activeKeys(req, 'contact'), lookupService.linksFor(req, 'contact', items)]);
  return { items: items.map((contact) => serializeContact(contact, keys, links)), pagination };
}

// Phase 3 (D115): the ids of the contacts the list's search and filters match, in its order, for
// "select all" in the Customers list without loading them (at most MATCH_MAX).
async function matchingIds(req, query) {
  const filter = await listFilter(req, query);
  const [docs, total] = await Promise.all([
    repo(req).find(filter).sort(sortSpec(query.sort, SORTS)).select('_id').limit(MATCH_MAX).lean(),
    repo(req).count(filter),
  ]);
  return { ids: docs.map((doc) => doc._id), total, max: MATCH_MAX };
}

async function findVisible(req, id, session) {
  const contact = await repo(req).findOne({ _id: id, ...visibilityFilter(req, MODULE), ...privacyFilter(req) }).session(session || null);
  if (!contact) throw httpError(404, 'NOT_FOUND', 'Contact not found');
  return contact;
}

// enforceRequired: false for the public API (D73).
async function create(req, body, { session, enforceRequired = true } = {}) {
  const data = normalizeFields(body);
  await assertPhoneFree(req, data.phoneE164, undefined, session);
  // Contacts added by hand count against the plan; WhatsApp messages and lead sources never stop.
  // Counted and saved under the company's contacts hold (D81), so adds at the same moment cannot
  // pass the limit together. (With a session, the caller commits after the hold is let go.)
  const { marketingConsent, customFields, ...fields } = data;
  const contact = await planService.withRoom(req.tenant.organizationId, [['contacts', { action: 'add contacts' }]], async () => repo(req).create({
    ...fields,
    ...(customFields !== undefined && { customFields: await customFieldService.applyValues(req, 'contact', customFields, undefined, { isNew: true, enforceRequired }) }),
    ...(marketingConsent && { consent: consentOf(marketingConsent, consentHistory.methodOf(req)) }),
    ownerId: await resolveOwnerId(req, body.ownerId),
    becameCustomerAt: data.lifecycle === 'customer' ? new Date() : undefined,
    createdById: req.user._id,
  }, { session }));
  await audit(req, { action: 'contact.created', entityType: 'Contact', entityId: contact._id });
  if (marketingConsent) await consentHistory.record({ organizationId: contact.organizationId, contactId: contact._id, from: 'unknown', to: marketingConsent, method: consentHistory.methodOf(req), ...consentHistory.actorOf(req), session }); // D79
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
async function update(req, id, patch, { session, skipVisibility = false, enforceRequired = true } = {}) {
  const contact = skipVisibility
    ? await repo(req).findById(id).session(session || null)
    : await findVisible(req, id, session);
  if (!contact) throw httpError(404, 'NOT_FOUND', 'Contact not found');
  const valuesBefore = JSON.stringify(contact.customFields || {});
  const consentBefore = contact.consent?.marketing || 'unknown'; // D79: the history keeps from → to
  const data = normalizeFields(Object.fromEntries(Object.entries(patch).filter(([key]) => EDITABLE.includes(key))));
  if ('phoneE164' in data) await assertPhoneFree(req, data.phoneE164, contact._id, session);
  if (data.lifecycle === 'customer' && contact.lifecycle !== 'customer') contact.becameCustomerAt = new Date();
  Object.assign(contact, data, await ownerPatch(req, patch));
  if (patch.marketingConsent && patch.marketingConsent !== (contact.consent?.marketing || 'unknown')) contact.consent = consentOf(patch.marketingConsent, consentHistory.methodOf(req));
  if ('phoneE164' in data && !data.phoneE164) contact.phoneE164 = undefined;
  if (patch.customFields !== undefined) {
    contact.customFields = await customFieldService.applyValues(req, 'contact', patch.customFields, contact.customFields, { enforceRequired });
    contact.markModified('customFields');
  }
  const changed = contact.modifiedPaths().some((p) => p !== 'customFields' && !p.startsWith('customFields.')) || JSON.stringify(contact.customFields || {}) !== valuesBefore;
  await contact.save({ session });
  const changes = [...Object.keys(data), ...(patch.customFields !== undefined ? ['customFields'] : [])];
  await audit(req, { action: 'contact.updated', entityType: 'Contact', entityId: contact._id, changes });
  if ((contact.consent?.marketing || 'unknown') !== consentBefore) {
    await consentHistory.record({ organizationId: contact.organizationId, contactId: contact._id, from: consentBefore, to: contact.consent.marketing, method: consentHistory.methodOf(req), ...consentHistory.actorOf(req), session });
  }
  // Outbound webhooks (D78). A change saved inside a larger transaction (a lead's form) is not
  // sent: it would go out even if that transaction were undone.
  if (changed && !session) {
    automationEvents.emit('contact.updated', { organizationId: contact.organizationId, contactId: contact._id, key: `contact.updated:${contact._id}:${contact.updatedAt?.getTime?.() || Date.now()}` }, req);
  }
  return contact;
}

async function remove(req, id) {
  const contact = await findVisible(req, id);
  contact.phoneE164 = undefined; // the number may be used by a new contact
  await contact.softDelete();
  await audit(req, { action: 'contact.deleted', entityType: 'Contact', entityId: contact._id });
}

// One contact as the API shows it: active fields and link names.
async function present(req, contact) {
  const [keys, links] = await Promise.all([customFieldService.activeKeys(req, 'contact'), lookupService.linksFor(req, 'contact', [contact])]);
  return serializeContact(contact, keys, links);
}

module.exports = {
  listFilter,
  listSort: (query) => sortSpec(query.sort, SORTS),
  list,
  matchingIds,
  get: async (req, id) => present(req, await findVisible(req, id)),
  create: async (req, body, options) => present(req, await create(req, body, options)),
  update: async (req, id, patch, options) => present(req, await update(req, id, patch, options)),
  remove,
  findOrCreate,
  consentOf,
  updateContact: update,
  findVisible,
  serializeContact,
  normalizeFields,
};
