const mongoose = require('mongoose');
const CustomFieldDefinition = require('../models/CustomFieldDefinition');
const CustomObjectDefinition = require('../models/CustomObjectDefinition');
const Organization = require('../models/Organization');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { can, isManager } = require('../constants/permissions');
const {
  modulesOf, OBJECT_KEY_PATTERN, MAX_ACTIVE_FIELDS, MAX_OPTIONS, TEXT_MAX, NUMBER_MAX, RESERVED_KEYS, MAX_LIST_COLUMNS,
} = require('../constants/customFields');

// Custom fields (Phase 1A, D73): owners and admins define them in Settings → Custom fields; the
// team fills them in the customer, lead and deal forms. This file has both halves: the
// definitions, and checking the values a record is saved with.

const forbidden = () => httpError(403, 'FORBIDDEN', 'You do not have permission to do this.');
const scope = (req, filter = {}) => ({ ...filter, organizationId: req.tenant.organizationId });

function serialize(field) {
  return {
    id: field._id,
    object: field.object,
    key: field.key,
    label: field.label,
    helpText: field.helpText || '',
    type: field.type,
    options: field.type === 'dropdown' ? (field.options || []).map((o) => ({ value: o.value, label: o.label, archived: Boolean(o.archived) })) : [],
    lookupTarget: field.type === 'lookup' ? field.lookupTarget : null,
    required: Boolean(field.required),
    listColumn: Boolean(field.listColumn),
    order: field.order,
    status: field.status,
    archivedAt: field.archivedAt || null,
    version: field.version,
    createdAt: field.createdAt,
    updatedAt: field.updatedAt,
  };
}

const limitError = () => httpError(422, 'FIELD_LIMIT', `You can have up to ${MAX_ACTIVE_FIELDS} fields here. Archive one you no longer use first.`);
const columnLimitError = () => httpError(422, 'COLUMN_LIMIT', `Up to ${MAX_LIST_COLUMNS} fields can be columns in a list. Take one off first.`);

// Adding or restoring a field writes the organization inside the transaction: a second admin
// doing the same at the same moment gets a write conflict, and the transaction retries after the
// first one has finished, so its count sees the new field.
const takeTurn = (req, session) => Organization.updateOne({ _id: req.tenant.organizationId }, { $inc: { customFieldsRevision: 1 } }, { session });

// "Visit date" → visit_date. Labels in Hindi (or anything without a-z) become field, field_2 …
// (fallback: the word used then, e.g. object for a custom object's key).
function keyFromLabel(label, taken, fallback = 'field') {
  let base = String(label).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 34).replace(/_+$/, '');
  if (!/^[a-z]/.test(base)) base = base ? `${fallback}_${base}`.slice(0, 34).replace(/_+$/, '') : fallback;
  if (base.length < 2) base = fallback;
  let key = base;
  for (let n = 2; taken.has(key) || RESERVED_KEYS.has(key); n += 1) key = `${base}_${n}`;
  return key;
}

const optionError = (message) => httpError(400, 'VALIDATION_ERROR', message, [{ field: 'options', code: 'INVALID_OPTIONS', message }]);

// The dropdown's choices. A choice keeps its value (o1, o2 …) forever; one left out of the list is
// archived, so records that have it keep it.
function buildOptions(input, existing = []) {
  const known = new Map(existing.map((option) => [option.value, option]));
  let next = Math.max(0, ...existing.map((option) => Number(String(option.value).slice(1)) || 0)) + 1;
  const seen = new Set();
  const options = [];
  for (const item of input) {
    if (item.value !== undefined && (!known.has(item.value) || seen.has(item.value))) throw optionError('A choice in the list is unknown or repeated. Reload and try again.');
    const value = item.value ?? `o${next++}`;
    seen.add(value);
    options.push({ value, label: item.label, archived: Boolean(item.archived) });
  }
  for (const option of existing) if (!seen.has(option.value)) options.push({ value: option.value, label: option.label, archived: true });
  const active = options.filter((option) => !option.archived).map((option) => option.label.toLowerCase());
  if (!active.length) throw optionError('A dropdown needs at least one choice.');
  if (new Set(active).size !== active.length) throw optionError('Two choices have the same name.');
  if (options.length > MAX_OPTIONS) throw optionError(`A dropdown can have up to ${MAX_OPTIONS} choices, archived ones included.`);
  return options;
}

async function findField(req, id, session) {
  const field = await CustomFieldDefinition.findOne(scope(req, { _id: id })).session(session || null);
  if (!field) throw httpError(404, 'NOT_FOUND', 'Field not found');
  return field;
}

// Everyone who can view customers (or leads/deals) reads the active fields, to fill in the forms;
// archived ones are for owners and admins (Settings).
// A company's own object (D75) must exist; an archived one only for owners and admins (Settings).
async function assertObject(req, object, { activeOnly = true } = {}) {
  if (!OBJECT_KEY_PATTERN.test(object)) return;
  const found = await CustomObjectDefinition.exists(scope(req, { key: object, ...(activeOnly && { status: 'active' }) }));
  if (!found) throw httpError(404, 'NOT_FOUND', 'Object not found');
}

async function list(req, { object, status = 'active' }) {
  if (!modulesOf(object).some((module) => can(req.member, module, 'view'))) throw forbidden();
  if (status === 'all' && !isManager(req.member)) throw forbidden();
  await assertObject(req, object, { activeOnly: status !== 'all' });
  const filter = scope(req, { object, ...(status === 'active' && { status: 'active' }) });
  return (await CustomFieldDefinition.find(filter).sort({ status: 1, order: 1, createdAt: 1 })).map(serialize);
}

// A link field (D75) points to customers, leads or one of the company's active objects.
async function assertLinkTarget(req, body) {
  if (body.type !== 'lookup') return;
  const target = body.lookupTarget;
  const ok = ['contact', 'lead'].includes(target) || (OBJECT_KEY_PATTERN.test(target) && await CustomObjectDefinition.exists(scope(req, { key: target, status: 'active' })));
  if (!ok) throw httpError(400, 'VALIDATION_ERROR', 'Choose what this field links to.', [{ field: 'lookupTarget', code: 'INVALID_LINK_TARGET', message: 'Choose what this field links to.' }]);
}

async function create(req, body) {
  await assertObject(req, body.object);
  await assertLinkTarget(req, body);
  let field;
  await mongoose.connection.transaction(async (session) => {
    field = null;
    await takeTurn(req, session);
    const existing = await CustomFieldDefinition.find(scope(req, { object: body.object })).select('key status order listColumn').session(session);
    const active = existing.filter((f) => f.status === 'active');
    if (active.length >= MAX_ACTIVE_FIELDS) throw limitError();
    if (body.listColumn && active.filter((f) => f.listColumn).length >= MAX_LIST_COLUMNS) throw columnLimitError();
    [field] = await CustomFieldDefinition.create([{
      organizationId: req.tenant.organizationId,
      object: body.object,
      key: keyFromLabel(body.label, new Set(existing.map((f) => f.key))),
      label: body.label,
      helpText: body.helpText || '',
      type: body.type,
      options: body.type === 'dropdown' ? buildOptions(body.options || []) : undefined,
      lookupTarget: body.type === 'lookup' ? body.lookupTarget : undefined,
      required: Boolean(body.required),
      listColumn: Boolean(body.listColumn),
      order: Math.max(-1, ...existing.map((f) => f.order)) + 1,
      createdById: req.user._id,
      updatedById: req.user._id,
    }], { session });
  });
  await audit(req, { action: 'custom_field.created', entityType: 'CustomFieldDefinition', entityId: field._id, changes: { object: field.object, key: field.key, type: field.type } });
  return serialize(field);
}

// Label, help text, required, list column and the dropdown's choices. object, key and type never change.
async function update(req, id, body) {
  const field = await findField(req, id);
  if (body.version !== undefined && body.version !== field.version) throw httpError(409, 'VERSION_CONFLICT', 'Someone else changed this field. Reload and try again.');
  const set = {};
  for (const key of ['label', 'helpText', 'required', 'listColumn']) if (key in body) set[key] = body[key];
  if ('options' in body) {
    if (field.type !== 'dropdown') throw httpError(400, 'VALIDATION_ERROR', 'Only a dropdown has choices.', [{ field: 'options', code: 'INVALID_OPTIONS', message: 'Only a dropdown has choices.' }]);
    set.options = buildOptions(body.options, field.options);
  }
  let updated;
  await mongoose.connection.transaction(async (session) => {
    updated = null;
    // A new list column takes its turn like a new field, so two admins cannot pass the limit.
    if (set.listColumn && !field.listColumn && field.status === 'active') {
      await takeTurn(req, session);
      const columns = await CustomFieldDefinition.countDocuments(scope(req, { object: field.object, status: 'active', listColumn: true, _id: { $ne: field._id } })).session(session);
      if (columns >= MAX_LIST_COLUMNS) throw columnLimitError();
    }
    updated = await CustomFieldDefinition.findOneAndUpdate(
      scope(req, { _id: field._id, version: field.version }),
      { $set: { ...set, updatedById: req.user._id }, $inc: { version: 1 } },
      { returnDocument: 'after', runValidators: true, session },
    );
  });
  if (!updated) throw httpError(409, 'VERSION_CONFLICT', 'Someone else changed this field. Reload and try again.');
  await audit(req, { action: 'custom_field.updated', entityType: 'CustomFieldDefinition', entityId: field._id, changes: Object.keys(set) });
  return serialize(updated);
}

// Hides the field from the forms; the values stay on the records. Repeating it is harmless.
async function archive(req, id) {
  const field = await findField(req, id);
  if (field.status === 'archived') return serialize(field);
  const updated = await CustomFieldDefinition.findOneAndUpdate(
    scope(req, { _id: field._id, status: 'active' }),
    { $set: { status: 'archived', archivedAt: new Date(), archivedById: req.user._id, updatedById: req.user._id }, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
  await audit(req, { action: 'custom_field.archived', entityType: 'CustomFieldDefinition', entityId: field._id });
  return serialize(updated || await findField(req, id));
}

// Brings an archived field back, at the end of the form, with the values it had.
async function restore(req, id) {
  let field;
  let restored = false;
  await mongoose.connection.transaction(async (session) => {
    restored = false;
    await takeTurn(req, session);
    field = await findField(req, id, session);
    if (field.status === 'active') return;
    const active = await CustomFieldDefinition.find(scope(req, { object: field.object, status: 'active' })).select('order listColumn').session(session);
    if (active.length >= MAX_ACTIVE_FIELDS) throw limitError();
    // Comes back as a list column only while there is room for one.
    if (field.listColumn && active.filter((f) => f.listColumn).length >= MAX_LIST_COLUMNS) field.listColumn = false;
    field.set({ status: 'active', archivedAt: undefined, archivedById: undefined, order: Math.max(-1, ...active.map((f) => f.order)) + 1, updatedById: req.user._id });
    field.version += 1;
    await field.save({ session });
    restored = true;
  });
  if (restored) await audit(req, { action: 'custom_field.restored', entityType: 'CustomFieldDefinition', entityId: field._id });
  return serialize(field);
}

// ids: every active field of the object, once each, in the new order.
async function reorder(req, { object, ids }) {
  const active = await CustomFieldDefinition.find(scope(req, { object, status: 'active' })).select('_id');
  const activeIds = new Set(active.map((field) => String(field._id)));
  if (ids.length !== activeIds.size || new Set(ids).size !== ids.length || ids.some((id) => !activeIds.has(id))) {
    throw httpError(400, 'VALIDATION_ERROR', 'The list of fields is out of date. Reload and try again.', [{ field: 'ids', code: 'INVALID_ORDER', message: 'List every active field once.' }]);
  }
  await CustomFieldDefinition.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: scope(req, { _id: id }), update: { $set: { order } } } })));
  await audit(req, { action: 'custom_field.reordered', entityType: 'CustomFieldDefinition', changes: { object, ids } });
  return list(req, { object });
}

// --- values on a record -----------------------------------------------------------------

// The company's fields for one object (archived too), read once per request.
function definitionsFor(req, object) {
  req.customFieldDefinitions = req.customFieldDefinitions || {};
  if (!req.customFieldDefinitions[object]) {
    req.customFieldDefinitions[object] = CustomFieldDefinition.find(scope(req, { object })).lean().exec();
  }
  return req.customFieldDefinitions[object];
}

async function activeKeys(req, object) {
  const definitions = await definitionsFor(req, object);
  return new Set(definitions.filter((field) => field.status === 'active').map((field) => field.key));
}

// What a record shows: the values of active fields only (an archived field's values come back
// when it is restored). Without keys, everything stored.
function visibleValues(values, keys) {
  const entries = Object.entries(values || {});
  return Object.fromEntries(keys ? entries.filter(([key]) => keys.has(key)) : entries);
}

const isEmpty = (raw) => raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');

function validDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// One value → what is stored, or { code, message }. undefined means "empty" (the key is removed).
// previous: the record's current value (a dropdown may keep a choice that was archived since).
function convert(field, raw, previous) {
  if (isEmpty(raw)) return { value: undefined };
  const fail = (code, message) => ({ error: { code, message } });
  switch (field.type) {
    case 'text':
    case 'textarea': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return fail('INVALID_TYPE', `${field.label} must be text.`);
      const text = String(raw).trim();
      if (text.length > TEXT_MAX[field.type]) return fail('TOO_LONG', `${field.label} can be at most ${TEXT_MAX[field.type]} characters.`);
      return { value: text };
    }
    case 'number': {
      const number = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
      if (!Number.isFinite(number)) return fail('INVALID_TYPE', `${field.label} must be a number.`);
      if (Math.abs(number) > NUMBER_MAX) return fail('OUT_OF_RANGE', `${field.label} is too large.`);
      if (!/^-?\d+(\.\d{1,2})?$/.test(String(number))) return fail('OUT_OF_RANGE', `${field.label} can have at most 2 decimal places.`);
      return { value: number };
    }
    case 'date': {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (!validDate(text)) return fail('INVALID_TYPE', `${field.label} must be a date like 2026-10-17.`);
      return { value: text };
    }
    case 'dropdown': {
      const option = (field.options || []).find((o) => o.value === raw);
      if (!option || (option.archived && raw !== previous)) return fail('INVALID_OPTION', `Pick one of the choices for ${field.label}.`);
      return { value: raw };
    }
    case 'checkbox':
      // Unticked is empty, so a required checkbox must be ticked.
      if (raw === true || raw === 'true') return { value: true };
      if (raw === false || raw === 'false') return { value: undefined };
      return fail('INVALID_TYPE', `${field.label} must be ticked or not.`);
    case 'lookup':
      // The record's id; whether it may be linked is checked in applyValues (it needs the database).
      if (typeof raw !== 'string' || !/^[a-f0-9]{24}$/.test(raw)) return fail('INVALID_LINK', `Pick a record for ${field.label}.`);
      return { value: raw };
    default:
      return fail('INVALID_TYPE', `${field.label} cannot be saved.`);
  }
}

// The values sent for a record (customFields: { key: value }) applied to what it has: returns the
// new customFields, or throws 400 naming every bad field. Only the sent keys change; empty clears
// one. Required fields: a new record saved from the CRM's forms (they always send customFields)
// must fill all of them, and an edit may not empty one. WhatsApp, lead sources, imports and the
// public API never send customFields, so they are never blocked.
// enforceRequired: false for the public API (D73: it is never stopped by a required field).
async function applyValues(req, object, input, existing, { isNew = false, enforceRequired = true } = {}) {
  const definitions = await definitionsFor(req, object);
  const byKey = new Map(definitions.map((field) => [field.key, field]));
  const values = { ...(existing || {}) };
  const errors = [];
  const fail = (key, code, message) => errors.push({ field: `customFields.${key}`, code, message });
  for (const [key, raw] of Object.entries(input || {})) {
    const field = byKey.get(key);
    if (!field) { fail(key, 'UNKNOWN_FIELD', 'This field does not exist. Reload the page.'); continue; }
    if (field.status !== 'active') { fail(key, 'FIELD_ARCHIVED', `${field.label} was archived. Reload the page.`); continue; }
    const { value, error } = convert(field, raw, values[key]);
    if (error) { fail(key, error.code, error.message); continue; }
    // A new link must point to a record of the right kind this member may see (D75); one the record
    // already has is kept as it is.
    if (field.type === 'lookup' && value !== undefined && value !== values[key]) {
      const lookupService = require('./lookupService'); // eslint-disable-line global-require
      if (!(await lookupService.check(req, field.lookupTarget, value))) { fail(key, 'INVALID_LINK', `Pick a record for ${field.label} from the list.`); continue; }
    }
    if (value === undefined) delete values[key];
    else values[key] = value;
  }
  for (const field of enforceRequired ? definitions : []) {
    if (field.status !== 'active' || !field.required || values[field.key] !== undefined) continue;
    const sent = Object.prototype.hasOwnProperty.call(input || {}, field.key);
    if ((isNew || sent) && !errors.some((e) => e.field === `customFields.${field.key}`)) fail(field.key, 'REQUIRED', `Fill in ${field.label}.`);
  }
  if (errors.length) throw httpError(400, 'VALIDATION_ERROR', errors[0].message, errors);
  return values;
}

// --- reading values people type (filters, CSV files, the public API) -----------------------

// "1,25,000", "₹ 2,500", "Rs. 99.50", "INR 10" → a number; NaN when it is not one.
function readNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  const text = String(raw ?? '').trim().replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/[,\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
}

// Names compared the way people write them: capitals, spaces and punctuation ignored, in any
// script (\p{M}: Hindi's vowel signs belong to the word).
const loose = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();

// YYYY-MM-DD, or DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (Indian files: day first, never month first).
function readDate(raw) {
  const text = String(raw ?? '').trim();
  if (validDate(text)) return text;
  const match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (!match) return null;
  const iso = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  return validDate(iso) ? iso : null;
}

const YES = new Set(['yes', 'y', 'true', '1', 'हाँ', 'हां', 'haan']);
const NO = new Set(['no', 'n', 'false', '0', 'नहीं', 'nahi']);

// A CSV cell → { value } (undefined = nothing to store) or { warning }. More forgiving than the
// form: Indian number and date formats, a dropdown choice by its name, yes/no words.
function readImportValue(field, raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { value: undefined };
  switch (field.type) {
    case 'text':
    case 'textarea': {
      const max = TEXT_MAX[field.type];
      return text.length > max ? { value: text.slice(0, max), warning: `${field.label} was cut to ${max} characters` } : { value: text };
    }
    case 'number': {
      const number = readNumber(text);
      if (!Number.isFinite(number) || Math.abs(number) > NUMBER_MAX || !/^-?\d+(\.\d{1,2})?$/.test(String(number))) return { warning: `${field.label}: "${text}" is not a number we can keep` };
      return { value: number };
    }
    case 'date': {
      const date = readDate(text);
      return date ? { value: date } : { warning: `${field.label}: "${text}" is not a date (use 20/10/2026 or 2026-10-20)` };
    }
    case 'dropdown': {
      const option = (field.options || []).find((o) => o.value === text || loose(o.label) === loose(text));
      if (!option) return { warning: `${field.label}: "${text}" is not one of its choices` };
      if (option.archived) return { warning: `${field.label}: "${text}" is a removed choice` };
      return { value: option.value };
    }
    case 'checkbox': {
      const word = loose(text);
      if (YES.has(word)) return { value: true };
      if (NO.has(word)) return { value: undefined };
      return { warning: `${field.label}: "${text}" is not yes or no` };
    }
    default:
      return { value: undefined };
  }
}

// The public API's shape (D74): active fields only, a dropdown as its choice's name.
function publicValues(values, fields) {
  const out = {};
  for (const field of fields || []) {
    const value = values?.[field.key];
    if (value === undefined || value === null) continue;
    out[field.key] = field.type === 'dropdown' ? ((field.options || []).find((o) => o.value === value)?.label ?? value) : value;
  }
  return out;
}

// From the public API: a dropdown may be given by its choice's name (or its value).
async function fromPublicValues(req, object, input) {
  if (!input) return input;
  const fields = await definitionsFor(req, object);
  return Object.fromEntries(Object.entries(input).map(([key, raw]) => {
    const field = fields.find((f) => f.key === key && f.type === 'dropdown');
    if (!field || typeof raw !== 'string' || field.options.some((o) => o.value === raw)) return [key, raw];
    const option = field.options.find((o) => !o.archived && loose(o.label) === loose(raw));
    return [key, option ? option.value : raw];
  }));
}

module.exports = {
  list,
  create,
  update,
  archive,
  restore,
  reorder,
  activeKeys,
  visibleValues,
  applyValues,
  keyFromLabel,
  serialize,
  fieldsFor: definitionsFor,
  takeTurn,
  assertObject,
  validDate,
  readNumber,
  readDate,
  readImportValue,
  loose,
  publicValues,
  fromPublicValues,
};
