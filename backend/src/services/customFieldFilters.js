const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const CustomRecord = require('../models/CustomRecord');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { escapeRegex } = require('../utils/listQuery');
const customFieldService = require('./customFieldService');
const {
  FILTER_OPERATORS, MAX_FILTERS, MAX_FILTER_CHOICES, MAX_SEARCH_FIELDS,
} = require('../constants/customFields');

// Phase 1B (D74): finding records by the company's own fields — list filters
// (cf=<key>:<operator>[:<value>], all must match) and search. The pages run the same rules in the
// browser (crm/frontend/js/custom-fields.js cfMatches); tests/customFieldsLists.test.js checks
// both against one table of cases.

const invalid = (message) => httpError(400, 'VALIDATION_ERROR', message, [{ field: 'cf', code: 'INVALID_FILTER', message }]);
const DATE_OPERATORS = { eq: null, before: '$lt', after: '$gt', from: '$gte', to: '$lte' };

// "credit_days:gte:30" → { key, operator, value }; the value may contain ":" itself.
function parse(text) {
  const [key = '', operator = '', ...rest] = String(text).split(':');
  return { key: key.trim(), operator: operator.trim(), value: rest.join(':').trim() };
}

function condition(field, operator, value) {
  const path = `customFields.${field.key}`;
  if (operator === 'empty') return { [path]: null }; // missing (never filled) or cleared
  if (operator === 'filled') return { [path]: { $exists: true, $ne: null } };
  switch (field.type) {
    case 'text':
    case 'textarea': {
      if (!value) throw invalid(`Give the words to look for in ${field.label}.`);
      const text = escapeRegex(value.slice(0, 100));
      return { [path]: new RegExp(operator === 'is' ? `^${text}$` : text, 'i') };
    }
    case 'number': {
      const number = customFieldService.readNumber(value);
      if (!Number.isFinite(number)) throw invalid(`${field.label} needs a number to compare with.`);
      return { [path]: operator === 'eq' ? number : { [`$${operator}`]: number } };
    }
    case 'date': {
      if (!customFieldService.validDate(value)) throw invalid(`${field.label} needs a date like 2026-10-17.`);
      const op = DATE_OPERATORS[operator];
      return { [path]: op ? { [op]: value } : value }; // YYYY-MM-DD strings sort like dates
    }
    case 'dropdown': {
      // Archived choices too: records may still have them.
      const values = value.split(',').map((v) => v.trim()).filter(Boolean);
      const known = new Set((field.options || []).map((o) => o.value));
      if (!values.length || values.length > MAX_FILTER_CHOICES || values.some((v) => !known.has(v))) {
        throw invalid(`Pick 1 to ${MAX_FILTER_CHOICES} of the choices of ${field.label}.`);
      }
      return { [path]: { $in: values } };
    }
    case 'checkbox':
      return operator === 'yes' ? { [path]: true } : { [path]: { $ne: true } };
    case 'lookup':
      // is: the linked record's id (D75; the pages pick it with the link picker).
      if (!/^[a-f0-9]{24}$/.test(value)) throw invalid(`Pick a record to filter ${field.label} by.`);
      return { [path]: value };
    default:
      throw invalid(`${field.label} cannot be filtered.`);
  }
}

// The cf parameter (one string or a list) → MongoDB conditions to AND with the list's filter.
async function conditions(req, object, filters) {
  const list = [].concat(filters || []).filter(Boolean);
  if (!list.length) return [];
  if (list.length > MAX_FILTERS) throw invalid(`Use at most ${MAX_FILTERS} field filters at a time.`);
  const fields = await customFieldService.fieldsFor(req, object);
  return list.map((text) => {
    const { key, operator, value } = parse(text);
    const field = fields.find((f) => f.key === key && f.status === 'active');
    if (!field) throw invalid(`There is no field "${key.slice(0, 40)}" to filter by. Reload the page.`);
    if (!FILTER_OPERATORS[field.type].includes(operator)) throw invalid(`${field.label} cannot be filtered with "${operator.slice(0, 20)}".`);
    return condition(field, operator, value);
  });
}

// Search: the term in the first active text and long-text fields, and in dropdowns whose
// choice names contain it. Numbers, dates and ticks are not searched.
async function searchClauses(req, object, q) {
  const term = String(q || '').trim();
  if (!term) return [];
  const pattern = new RegExp(escapeRegex(term.slice(0, 100)), 'i');
  const fields = (await customFieldService.fieldsFor(req, object))
    .filter((field) => field.status === 'active')
    .sort((a, b) => a.order - b.order);
  const clauses = fields
    .filter((field) => field.type === 'text' || field.type === 'textarea')
    .slice(0, MAX_SEARCH_FIELDS)
    .map((field) => ({ [`customFields.${field.key}`]: pattern }));
  for (const field of fields.filter((f) => f.type === 'dropdown')) {
    const values = (field.options || []).filter((o) => pattern.test(o.label)).map((o) => o.value);
    if (values.length) clauses.push({ [`customFields.${field.key}`]: { $in: values } });
  }
  return clauses;
}

// { organizationId, customFields.<any key> } on Contact, Lead and CustomRecord: a compound wildcard index, which
// needs MongoDB 7.0 or newer. On an older server the filters work without it (slower).
const VALUE_INDEX = { organizationId: 1, 'customFields.$**': 1 };
async function ensureValueIndexes() {
  try {
    const { version } = await mongoose.connection.db.admin().serverInfo();
    if (Number(String(version).split('.')[0]) < 7) {
      logger.warn(`MongoDB ${version}: custom field filters run without an index (it needs MongoDB 7.0 or newer).`);
      return false;
    }
    await Promise.all([Contact, Lead, CustomRecord].map((Model) => Model.collection.createIndex(VALUE_INDEX, { name: 'organizationId_1_customFields_wildcard' })));
    return true;
  } catch (error) {
    logger.warn(`The custom field index was not created: ${error.message}`);
    return false;
  }
}

module.exports = { conditions, searchClauses, ensureValueIndexes, parse, VALUE_INDEX };
