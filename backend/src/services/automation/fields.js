const customFieldService = require('../customFieldService');
const httpError = require('../../utils/httpError');
const { can } = require('../../constants/permissions');
const { modulesOf, MAX_FILTER_CHOICES } = require('../../constants/customFields');
const { FIELD_CONDITION, FIELD_CONDITION_OPS, NO_VALUE_OPS } = require('../../constants/automation');

// The company's own fields (D73) in automations (D99): conditions on a customer's or a lead's
// field ("cf.contact.<key>", "cf.lead.<key>") and their values in messages ({{contact.cf.<key>}},
// {{lead.cf.<key>}}, or a template blank filled with "contact.cf.<key>"). The engine reads every
// field, as the company does; a member building a workflow may only use the fields they may see
// (D77) of the records they may open.

const OBJECTS = ['contact', 'lead'];
const NAMES = { contact: 'Customer', lead: 'Lead' };
const SPEC = /^(contact|lead)\.cf\.([a-z][a-z0-9_]{1,39})$/;
const PLACEHOLDER = /\{\{\s*(contact|lead)\.cf\.([a-z][a-z0-9_]{0,39})\s*\}\}/g;
const invalid = (field, message, code) => httpError(400, 'VALIDATION_ERROR', message, [{ field, code, message }]);
const isEmpty = (value) => value === undefined || value === null || value === '';
const asList = (value) => (Array.isArray(value) ? value : isEmpty(value) ? [] : [value]);

// "cf.contact.zone" → { object: 'contact', key: 'zone' }; anything else → null.
function conditionTarget(field) {
  const match = FIELD_CONDITION.exec(String(field || ''));
  return match ? { object: match[1], key: match[2] } : null;
}

// A template blank "lead.cf.budget" → { object: 'lead', key: 'budget' }; anything else → null.
function specTarget(spec) {
  const match = SPEC.exec(String(spec || ''));
  return match ? { object: match[1], key: match[2] } : null;
}

// --- the engine ------------------------------------------------------------------------------
// The company itself: every field and every linked record (automations run for the whole company).
const companyReq = (organizationId) => ({ tenant: { organizationId }, member: { role: 'owner', status: 'active', modules: [], permissions: [] } });

// For automation/context.js: the fields of customers and leads (archived ones too), and the
// record's filled values as words ({ contact: { key: text }, lead: { … } }).
async function contextOf(organizationId, { contact, lead }) {
  const req = companyReq(organizationId);
  const [contactFields, leadFields, contactTexts, leadTexts] = await Promise.all([
    customFieldService.fieldsFor(req, 'contact'),
    customFieldService.fieldsFor(req, 'lead'),
    contact ? customFieldService.displayTexts(req, 'contact', contact) : {},
    lead ? customFieldService.displayTexts(req, 'lead', lead) : {},
  ]);
  return { fields: { contact: contactFields, lead: leadFields }, fieldTexts: { contact: contactTexts, lead: leadTexts } };
}

const fieldOf = (ctx, target) => (target ? (ctx.fields?.[target.object] || []).find((field) => field.key === target.key) : null);

// Does the record's value pass the condition? The same words as the list filters (D74). An
// archived field reads as empty (its values come back when it is restored); a missing one fails.
function matches(ctx, condition) {
  const target = conditionTarget(condition.field);
  const field = fieldOf(ctx, target);
  if (!field) return false;
  const stored = field.status === 'active' ? ctx[target.object]?.customFields?.[target.key] : undefined;
  const { op, value } = condition;
  const empty = isEmpty(stored);
  if (op === 'empty') return empty;
  if (op === 'filled') return !empty;
  switch (field.type) {
    case 'text':
    case 'textarea': {
      const want = String(value ?? '').trim().toLowerCase();
      if (empty || !want) return false;
      const have = String(stored).trim().toLowerCase();
      return op === 'is' ? have === want : have.includes(want);
    }
    case 'number': {
      const number = Number(value);
      if (typeof stored !== 'number' || !Number.isFinite(number) || isEmpty(value)) return false;
      return { eq: stored === number, gt: stored > number, gte: stored >= number, lt: stored < number, lte: stored <= number }[op] || false;
    }
    case 'date': {
      const want = String(value ?? '');
      if (empty || !want) return false;
      const have = String(stored); // YYYY-MM-DD sorts like a date
      return { eq: have === want, before: have < want, after: have > want, from: have >= want, to: have <= want }[op] || false;
    }
    case 'dropdown': {
      const inList = !empty && asList(value).includes(stored);
      return op === 'notIn' ? !inList : inList;
    }
    case 'checkbox':
      return op === 'yes' ? stored === true : stored !== true;
    case 'lookup':
      return !empty && String(stored) === String(value);
    default:
      return false;
  }
}

// What the record has, as words (the builder's "Try it on a lead").
function actualText(ctx, condition) {
  const target = conditionTarget(condition.field);
  return (target && ctx.fieldTexts?.[target.object]?.[target.key]) || '';
}

// --- building a workflow ------------------------------------------------------------------
// The fields a member may use: those they may see (D77) on the records they may open.
async function fieldsFor(req, object) {
  if (!modulesOf(object).some((module) => can(req.member, module, 'view'))) return [];
  return customFieldService.fieldsFor(req, object);
}

// The active fields a member may use, in the forms' order, for the builders (workflowService.meta).
async function metaOf(req) {
  const out = [];
  for (const object of OBJECTS) {
    const fields = (await fieldsFor(req, object)).filter((field) => field.status === 'active')
      .sort((a, b) => a.order - b.order || new Date(a.createdAt) - new Date(b.createdAt));
    for (const field of fields) {
      out.push({
        object,
        key: field.key,
        label: field.label,
        type: field.type,
        ...(field.type === 'dropdown' && { options: (field.options || []).filter((o) => !o.archived).map((o) => ({ value: o.value, label: o.label })) }),
        ...(field.type === 'lookup' && { lookupTarget: field.lookupTarget }),
      });
    }
  }
  return out;
}

// A condition on a field, after the validator's shape check: the field is one this member may
// use, the words go with its type and the value fits it. An archived field may stay (the
// builder warns about it).
async function checkCondition(req, condition, path) {
  const target = conditionTarget(condition.field);
  const field = (await fieldsFor(req, target.object)).find((f) => f.key === target.key);
  if (!field) throw invalid(`${path}.field`, 'This field does not exist any more. Pick another one.', 'UNKNOWN_FIELD');
  if (!(FIELD_CONDITION_OPS[field.type] || []).includes(condition.op)) throw invalid(`${path}.op`, `"${condition.op}" does not go with ${field.label}.`, 'INVALID_OP');
  if (NO_VALUE_OPS.has(condition.op)) return;
  const { value } = condition;
  const bad = (message) => invalid(`${path}.value`, message, 'INVALID_VALUE');
  switch (field.type) {
    case 'text':
    case 'textarea':
      if (typeof value !== 'string' || !value.trim() || value.length > 100) throw bad(`Write the words to look for in ${field.label}.`);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad(`${field.label} needs a number to compare with.`);
      return;
    case 'date':
      if (!customFieldService.validDate(String(value))) throw bad(`${field.label} needs a date like 2026-10-17.`);
      return;
    case 'dropdown': {
      const known = new Set((field.options || []).map((o) => o.value));
      if (!Array.isArray(value) || !value.length || value.length > MAX_FILTER_CHOICES || value.some((v) => !known.has(v))) {
        throw bad(`Pick 1 to ${MAX_FILTER_CHOICES} of the choices of ${field.label}.`);
      }
      return;
    }
    case 'lookup': {
      const lookupService = require('../lookupService'); // eslint-disable-line global-require
      if (!(await lookupService.check(req, field.lookupTarget, value))) throw bad(`Pick a record for ${field.label}.`);
      return;
    }
    default:
      throw bad(`${field.label} cannot be checked.`);
  }
}

// The fields of the conditions that were archived since (the builder warns: they read as empty).
async function archivedConditions(req, conditions) {
  const out = [];
  for (const [index, condition] of conditions.entries()) {
    const target = conditionTarget(condition?.field);
    if (!target) continue;
    const field = (await fieldsFor(req, target.object)).find((f) => f.key === target.key);
    if (field?.status === 'archived') out.push({ index, label: field.label });
  }
  return out;
}

// May this member fill a template blank with "contact.cf.<key>": an active field they may use?
async function isSpec(req, spec) {
  const target = specTarget(spec);
  if (!target) return false;
  return (await fieldsFor(req, target.object)).some((field) => field.key === target.key && field.status === 'active');
}

// Every {{contact.cf.<key>}} / {{lead.cf.<key>}} in a step's texts (fixed words of template
// blanks too) must be an active field this member may use: a hidden field (D77) never reaches a
// message or a bell note through a workflow.
async function checkTexts(req, params, path) {
  const texts = [];
  const walk = (value, at) => {
    if (typeof value === 'string') texts.push([value, at]);
    else if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${at}.${i}`));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => walk(item, `${at}.${key}`));
  };
  walk(params, path);
  for (const [text, at] of texts) {
    for (const [placeholder, object, key] of text.matchAll(PLACEHOLDER)) {
      if (!(await isSpec(req, `${object}.cf.${key}`))) throw invalid(at, `${placeholder.replace(/\s+/g, '')} is not one of your ${object === 'contact' ? 'customer' : 'lead'} fields.`, 'UNKNOWN_PLACEHOLDER');
    }
  }
}

module.exports = {
  NAMES, conditionTarget, specTarget, contextOf, matches, actualText, fieldsFor, metaOf, checkCondition, archivedConditions, isSpec, checkTexts,
};
