const Organization = require('../models/Organization');
const PrivacyRequest = require('../models/PrivacyRequest');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');

// The company's privacy settings and its register of customers' data requests (Phase 8, D120).
// India's DPDP Act 2023 makes the company the "data fiduciary" for its customers' data and the
// CRM its processor: the company publishes who answers questions about the data (s. 8(9)), gives a
// customer a copy of their data (s. 11) and erases it on request (s. 12), and answers within
// 90 days (DPDP Rules 2025, rule 14(3)). docs/DATA_TRUST.md.

// Missing (an organization saved before Phase 8) counts as the defaults.
function settingsOf(organization) {
  const privacy = organization?.settings?.privacy || {};
  return {
    contactName: privacy.contactName || '',
    contactEmail: privacy.contactEmail || '',
    contactPhone: privacy.contactPhone || '',
    noticeUrl: privacy.noticeUrl || '',
    deviceCopies: privacy.deviceCopies !== false,
    requestsBy: privacy.requestsBy === 'owners' ? 'owners' : 'managers',
  };
}

// What customers see (the data file, the website form, quotation pages): the privacy contact, or
// the company's own email and phone when nobody was named.
function publicContactOf(organization) {
  const settings = settingsOf(organization);
  const named = Boolean(settings.contactName || settings.contactEmail || settings.contactPhone);
  return {
    name: settings.contactName,
    email: named ? settings.contactEmail : organization?.email || '',
    phone: named ? settings.contactPhone : organization?.phone || '',
    noticeUrl: settings.noticeUrl,
  };
}

const load = (req) => Organization.findById(req.tenant.organizationId).select('name email phone settings.privacy').lean();

// GET /organization/privacy — owners and admins.
async function getSettings(req) {
  const organization = await load(req);
  return { ...settingsOf(organization), canChangeWho: req.member?.role === 'owner', company: { email: organization?.email || '', phone: organization?.phone || '' } };
}

// PUT /organization/privacy — owners and admins; only an owner changes who handles requests (an
// admin could otherwise give the power back to themselves).
async function updateSettings(req, patch) {
  const organization = await load(req);
  const before = settingsOf(organization);
  if (patch.requestsBy && patch.requestsBy !== before.requestsBy && req.member?.role !== 'owner') {
    throw httpError(403, 'FORBIDDEN', 'Only an owner can change who gives or erases customers\' data.');
  }
  const changes = {};
  for (const key of Object.keys(before)) {
    if (key in patch && patch[key] !== before[key]) changes[key] = patch[key];
  }
  if (Object.keys(changes).length) {
    await Organization.updateOne(
      { _id: req.tenant.organizationId },
      { $set: Object.fromEntries(Object.entries(changes).map(([key, value]) => [`settings.privacy.${key}`, value])) },
    );
    await audit(req, { action: 'organization.privacy_updated', entityType: 'Organization', entityId: req.tenant.organizationId, changes: Object.keys(changes) });
  }
  return getSettings(req);
}

// Owners always; admins unless the company keeps it to owners.
async function assertMayHandle(req) {
  const role = req.member?.role;
  if (role === 'owner') return;
  if (role === 'admin' && settingsOf(await load(req)).requestsBy !== 'owners') return;
  throw httpError(403, 'FORBIDDEN', role === 'admin'
    ? 'Only owners can give or erase a customer\'s data in this company.'
    : 'Only owners and admins can give or erase a customer\'s data.');
}

const DAY_MS = 24 * 60 * 60 * 1000;

// A request answered, for the register (never throws: the answer itself was given).
async function record(req, entry) {
  try {
    return await PrivacyRequest.create({
      organizationId: req.tenant.organizationId,
      byMemberId: req.member?._id,
      byName: req.member?.displayName || req.user?.name || req.user?.email || '',
      doneAt: new Date(),
      ...entry,
    });
  } catch (error) {
    require('../config/logger').error(`A privacy request could not be added to the register: ${error.message}`); // eslint-disable-line global-require
    return null;
  }
}

const serialize = (r) => ({
  id: r._id,
  type: r.type,
  contactId: r.contactId,
  contactName: r.contactName || '',
  askedAt: r.askedAt,
  doneAt: r.doneAt,
  days: Math.max(0, Math.round((new Date(r.doneAt) - new Date(r.askedAt)) / DAY_MS)),
  byName: r.byName || '',
  format: r.format || null,
  summary: r.summary || null,
  keptUntil: r.keptUntil || null,
});

// GET /organization/privacy/requests — the register, newest first.
async function requests(req, { page = 1, limit = 50 } = {}) {
  await assertMayHandle(req);
  const filter = { organizationId: req.tenant.organizationId };
  const [items, total] = await Promise.all([
    PrivacyRequest.find(filter).sort({ doneAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    PrivacyRequest.countDocuments(filter),
  ]);
  return { items: items.map(serialize), pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

// GET /organization/privacy/customers?q= — the customer a request is about, by name, mobile,
// email or company, deleted ones too (their data is still kept); never one already erased; a
// private number (D61) only for owners. At most 20.
async function findCustomers(req, { q }) {
  await assertMayHandle(req);
  const Contact = require('../models/Contact'); // eslint-disable-line global-require
  const { escapeRegex } = require('../utils/listQuery'); // eslint-disable-line global-require
  const text = new RegExp(escapeRegex(q), 'i');
  const digits = q.replace(/\D/g, '');
  const or = [{ name: text }, { email: text }, { company: text }];
  if (digits.length >= 5) {
    or.push({ phoneE164: new RegExp(`${digits.slice(-10)}$`) });
    or.push({ phone: new RegExp(digits.slice(-10).split('').join('\\D*')) });
  }
  const filter = {
    organizationId: req.tenant.organizationId,
    'erasure.at': null,
    $or: or,
    ...(req.member?.role !== 'owner' && { private: { $ne: true } }),
  };
  const found = await Contact.collection.find(filter).sort({ deletedAt: 1, updatedAt: -1 }).limit(20)
    .project({ name: 1, phone: 1, phoneE164: 1, email: 1, company: 1, deletedAt: 1, createdAt: 1 }).toArray();
  return found.map((c) => ({
    id: c._id, name: c.name || '', phone: c.phoneE164 || c.phone || '', email: c.email || '', company: c.company || '',
    deleted: Boolean(c.deletedAt), createdAt: c.createdAt,
  }));
}

// The day the customer asked (India's calendar day, YYYY-MM-DD): today means now; an earlier day
// its noon in India; never a day still to come.
function askedAtOf(value, now = new Date()) {
  if (!value) return now;
  const today = new Date(now.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
  if (value > today) throw httpError(400, 'VALIDATION_ERROR', 'The day the customer asked cannot be in the future.', [{ field: 'askedAt', message: 'Pick today or an earlier day.' }]);
  if (value === today) return now;
  const asked = new Date(`${value}T12:00:00+05:30`);
  return Number.isNaN(asked.getTime()) ? now : asked;
}

module.exports = { settingsOf, publicContactOf, getSettings, updateSettings, assertMayHandle, record, requests, findCustomers, askedAtOf, serialize };
