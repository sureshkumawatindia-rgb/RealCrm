const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const CustomRecord = require('../models/CustomRecord');
const CustomObjectDefinition = require('../models/CustomObjectDefinition');
const httpError = require('../utils/httpError');
const { escapeRegex } = require('../utils/listQuery');
const { can } = require('../constants/permissions');
const { modulesOf, OBJECT_KEY_PATTERN } = require('../constants/customFields');
const { visibilityFilter, privacyFilter } = require('./access');
const customFieldService = require('./customFieldService');

// Links between records (Phase 1C, D75): what a link field may point to, the link picker's
// search, and the names shown for linked records. A member can only link to records they may
// see; a linked record they may not see shows as { hidden: true }, a deleted one as { missing: true }.

const ID = /^[a-f0-9]{24}$/;
const isObject = (target) => OBJECT_KEY_PATTERN.test(String(target));
const canView = (req, target) => modulesOf(target).some((module) => can(req.member, module, 'view'));

const activeObject = (req, key) => CustomObjectDefinition.exists({ organizationId: req.tenant.organizationId, key, status: 'active' });

// The target's model and what this member may see of it.
function scopeOf(req, target) {
  const organizationId = req.tenant.organizationId;
  if (target === 'contact') return { Model: Contact, base: { organizationId }, seen: { ...visibilityFilter(req, 'customers'), ...privacyFilter(req) } };
  if (target === 'lead') return { Model: Lead, base: { organizationId }, seen: { ...visibilityFilter(req, ['leads', 'deals']), ...privacyFilter(req) } };
  return { Model: CustomRecord, base: { organizationId, object: target }, seen: visibilityFilter(req, 'customers') };
}

function describe(target, doc) {
  if (target === 'contact') return { name: doc.name, subtitle: doc.company || doc.city || '' };
  if (target === 'lead') return { name: doc.title || doc.contactId?.name || 'Lead', subtitle: [doc.title && doc.contactId?.name, doc.stage].filter(Boolean).join(' · ') };
  return { name: doc.name, subtitle: '' };
}

function visible(req, target, filter, limit) {
  const { Model, base, seen } = scopeOf(req, target);
  let query = Model.find({ ...filter, ...seen, ...base })
    .select(target === 'contact' ? 'name company city' : target === 'lead' ? 'title stage contactId' : 'name')
    .sort({ updatedAt: -1 })
    .lean();
  if (limit) query = query.limit(limit);
  if (target === 'lead') query = query.populate({ path: 'contactId', select: 'name' });
  return query;
}

// GET /lookup?target=&q= — up to 20 records for the link picker, newest first.
async function search(req, { target, q = '', limit = 20 }) {
  if (!canView(req, target)) throw httpError(403, 'FORBIDDEN', 'You do not have permission to do this.');
  if (isObject(target) && !(await activeObject(req, target))) throw httpError(404, 'NOT_FOUND', 'Not found');
  const term = String(q).trim().slice(0, 100);
  let filter = {};
  if (term) {
    const pattern = new RegExp(escapeRegex(term), 'i');
    if (target === 'contact') filter = { $or: [{ name: pattern }, { company: pattern }, { email: pattern }, { phoneE164: pattern }] };
    else if (target === 'lead') {
      const contacts = await Contact.find({ organizationId: req.tenant.organizationId, name: pattern }).select('_id').limit(200);
      filter = { $or: [{ title: pattern }, { contactId: { $in: contacts.map((c) => c._id) } }] };
    } else filter = { name: pattern };
  }
  const docs = await visible(req, target, filter, Math.min(Number(limit) || 20, 20));
  return docs.map((doc) => ({ id: String(doc._id), ...describe(target, doc) }));
}

// May this member link to that record? It must be in the company, not deleted, of the right kind
// (an active object for x_ targets) and visible to them.
async function check(req, target, id) {
  if (!ID.test(String(id || ''))) return false;
  if (!canView(req, target)) return false;
  if (isObject(target) && !(await activeObject(req, target))) return false;
  const { Model, base, seen } = scopeOf(req, target);
  return Boolean(await Model.exists({ _id: id, ...seen, ...base }));
}

// ids → Map id → { id, name } | { id, hidden: true } | { id, missing: true }.
async function resolve(req, target, ids) {
  const unique = [...new Set(ids.map(String).filter((id) => ID.test(id)))];
  const out = new Map();
  if (!unique.length) return out;
  const seenDocs = canView(req, target) ? await visible(req, target, { _id: { $in: unique } }) : [];
  for (const doc of seenDocs) out.set(String(doc._id), { id: String(doc._id), name: describe(target, doc).name });
  const rest = unique.filter((id) => !out.has(id));
  if (rest.length) {
    const { Model, base } = scopeOf(req, target);
    const there = new Set((await Model.find({ _id: { $in: rest }, ...base }).select('_id').lean()).map((doc) => String(doc._id)));
    for (const id of rest) out.set(id, there.has(id) ? { id, hidden: true } : { id, missing: true });
  }
  return out;
}

// For a page of records of one object: Map recordId → { fieldKey: link } for its link fields.
async function linksFor(req, object, docs) {
  const result = new Map();
  if (!docs.length) return result;
  const fields = (await customFieldService.fieldsFor(req, object)).filter((f) => f.status === 'active' && f.type === 'lookup');
  if (!fields.length) return result;
  const idsByTarget = new Map();
  for (const field of fields) {
    for (const doc of docs) {
      const id = doc.customFields?.[field.key];
      if (!id) continue;
      if (!idsByTarget.has(field.lookupTarget)) idsByTarget.set(field.lookupTarget, []);
      idsByTarget.get(field.lookupTarget).push(id);
    }
  }
  const resolved = new Map(await Promise.all([...idsByTarget].map(async ([target, ids]) => [target, await resolve(req, target, ids)])));
  for (const doc of docs) {
    const links = {};
    for (const field of fields) {
      const id = doc.customFields?.[field.key];
      if (id) links[field.key] = resolved.get(field.lookupTarget)?.get(String(id)) || { id: String(id), missing: true };
    }
    result.set(String(doc._id), links);
  }
  return result;
}

module.exports = { search, check, resolve, linksFor, canView };
