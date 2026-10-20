// Custom fields (Phase 1A, D73): a company's own fields on its customers and leads. The objects
// that can have them, the field types and the limits. The values live on the record itself
// (Contact.customFields, Lead.customFields: key → value).

// The built-in objects; a company's own objects (Phase 1C, D75) have keys like x_machines.
const CUSTOM_FIELD_OBJECTS = Object.freeze(['contact', 'lead']);
const OBJECT_KEY_PATTERN = /^x_[a-z][a-z0-9_]{1,37}$/;
const isObjectKey = (object) => CUSTOM_FIELD_OBJECTS.includes(object) || OBJECT_KEY_PATTERN.test(String(object));
// lookup (D75): a link to one record — a customer, a lead or a record of an object (lookupTarget).
const CUSTOM_FIELD_TYPES = Object.freeze(['text', 'textarea', 'number', 'date', 'dropdown', 'checkbox', 'lookup']);
const CUSTOM_FIELD_STATUSES = Object.freeze(['active', 'archived']);

// Which modules' "view" lets a member read an object's fields (to fill in the forms). Leads are
// also the deals (D13).
const OBJECT_MODULES = Object.freeze({ contact: ['customers'], lead: ['leads', 'deals'] });
// A company's own objects and their records follow the Customers module (D75).
const modulesOf = (object) => OBJECT_MODULES[object] || ['customers'];

// Custom objects (D75): every plan, the trial too; archived ones do not count.
const MAX_CUSTOM_OBJECTS = 10;
const OBJECT_NAME_MAX = 40;
const OBJECT_ICONS = Object.freeze(['box', 'gear', 'truck', 'building', 'location-dot', 'file-contract', 'shield-halved', 'wrench', 'bolt', 'tag', 'user-gear', 'warehouse']);

// Every plan, the trial too (D73). Archived fields do not count.
const MAX_ACTIVE_FIELDS = 50;
const MAX_OPTIONS = 100;
const LABEL_MAX = 60;
const HELP_TEXT_MAX = 200;
const TEXT_MAX = Object.freeze({ text: 255, textarea: 2000 });
const NUMBER_MAX = 1e12;

// Phase 1B (D74): filters (cf=<key>:<operator>[:<value>], all must match), list columns and search.
const FILTER_OPERATORS = Object.freeze({
  text: ['has', 'is', 'empty', 'filled'],
  textarea: ['has', 'is', 'empty', 'filled'],
  number: ['eq', 'gt', 'gte', 'lt', 'lte', 'empty', 'filled'],
  date: ['eq', 'before', 'after', 'from', 'to', 'empty', 'filled'],
  dropdown: ['in', 'empty', 'filled'],
  checkbox: ['yes', 'no'],
  lookup: ['is', 'empty', 'filled'],
});
const MAX_FILTERS = 5;
const MAX_FILTER_CHOICES = 20;
const MAX_LIST_COLUMNS = 3;
// Search looks in this many text fields per object at most (it uses no index).
const MAX_SEARCH_FIELDS = 20;

// Sections (Phase 1D, D76): headings that group an object's fields in the forms, 1 or 2 columns.
const MAX_SECTIONS = 10;
const SECTION_LABEL_MAX = 40;
const SECTION_ID_PATTERN = /^s\d{1,4}$/;

// A key is made from the label once and never changes.
const KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
// Names an object already has (keys are stored as properties of customFields).
const RESERVED_KEYS = Object.freeze(new Set([
  'constructor', 'prototype', 'tostring', 'tolocalestring', 'valueof', 'hasownproperty', 'isprototypeof', 'propertyisenumerable',
]));

module.exports = {
  CUSTOM_FIELD_OBJECTS,
  OBJECT_KEY_PATTERN,
  isObjectKey,
  modulesOf,
  MAX_CUSTOM_OBJECTS,
  OBJECT_NAME_MAX,
  OBJECT_ICONS,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_STATUSES,
  OBJECT_MODULES,
  MAX_ACTIVE_FIELDS,
  MAX_OPTIONS,
  LABEL_MAX,
  HELP_TEXT_MAX,
  TEXT_MAX,
  NUMBER_MAX,
  KEY_PATTERN,
  RESERVED_KEYS,
  FILTER_OPERATORS,
  MAX_FILTERS,
  MAX_FILTER_CHOICES,
  MAX_LIST_COLUMNS,
  MAX_SEARCH_FIELDS,
  MAX_SECTIONS,
  SECTION_LABEL_MAX,
  SECTION_ID_PATTERN,
};
