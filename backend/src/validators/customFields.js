const Joi = require('joi');
const { objectId } = require('./common');
const { paginationQuery } = require('../utils/pagination');
const {
  CUSTOM_FIELD_OBJECTS, CUSTOM_FIELD_TYPES, MAX_ACTIVE_FIELDS, MAX_OPTIONS, LABEL_MAX, HELP_TEXT_MAX, MAX_FILTERS,
  OBJECT_KEY_PATTERN, OBJECT_NAME_MAX, OBJECT_ICONS, MAX_CUSTOM_OBJECTS, MAX_SECTIONS, SECTION_LABEL_MAX, SECTION_ID_PATTERN, AGENT_ACCESS, VIEWER_ACCESS,
} = require('../constants/customFields');

// Settings → Custom fields (D73), and the company's own objects and their records (D75).
// The built-in objects, or one of the company's own (x_machines; checked in the services).
const builtInObject = Joi.string().valid(...CUSTOM_FIELD_OBJECTS);
const objectKey = Joi.string().pattern(OBJECT_KEY_PATTERN).messages({ 'string.pattern.base': 'Unknown object' });
const object = Joi.alternatives().try(builtInObject, objectKey).messages({ 'alternatives.match': 'Unknown object' });
const label = Joi.string().trim().min(1).max(LABEL_MAX);
const helpText = Joi.string().trim().max(HELP_TEXT_MAX).allow('');
const fixed = (message) => Joi.any().forbidden().messages({ 'any.unknown': message });
const newOption = Joi.object({ label: label.required() });
const option = Joi.object({ value: Joi.string().trim().max(10), label: label.required(), archived: Joi.boolean() });
const objectName = Joi.string().trim().min(1).max(OBJECT_NAME_MAX);
// A section (D76): s1, s2 … null = "More details".
const sectionId = Joi.string().pattern(SECTION_ID_PATTERN).allow(null).messages({ 'string.pattern.base': 'Unknown section' });
// Who may see and change a field (D77); owners and admins always may.
const access = Joi.object({ agent: Joi.string().valid(...AGENT_ACCESS), viewer: Joi.string().valid(...VIEWER_ACCESS) }).min(1);

// ?cf=<key>:<operator>[:<value>] on the contact and lead lists (D74), once or repeated. Each one is
// checked against the company's fields in services/customFieldFilters.js.
const fieldFilters = Joi.array().items(Joi.string().trim().max(300)).single().max(MAX_FILTERS)
  .messages({ 'array.max': `Use at most ${MAX_FILTERS} field filters at a time.` });

// The values on a record (D73): { key: value }. Each value is checked against its field in
// services/customFieldService.js (an unknown key is refused there, not dropped here).
const customFieldValues = Joi.object()
  .pattern(Joi.string().max(60), Joi.alternatives().try(Joi.string().max(5000).allow(''), Joi.number(), Joi.boolean()).allow(null))
  .max(MAX_ACTIVE_FIELDS);

module.exports = {
  fieldFilters,
  customFieldValues,
  // The public API's list of fields (D74): customers and leads only.
  publicFieldList: Joi.object({ object: builtInObject.required() }),
  fieldList: Joi.object({
    object: object.required(),
    status: Joi.string().valid('active', 'all').default('active'),
  }),
  fieldCreate: Joi.object({
    object: object.required(),
    label: label.required(),
    type: Joi.string().valid(...CUSTOM_FIELD_TYPES).required(),
    helpText,
    required: Joi.boolean(),
    sectionId,
    access,
    listColumn: Joi.boolean(),
    options: Joi.when('type', {
      is: 'dropdown',
      then: Joi.array().items(newOption).min(1).max(MAX_OPTIONS).required(),
      otherwise: Joi.forbidden().messages({ 'any.unknown': 'Only a dropdown has choices.' }),
    }),
    // A link field (D75): what it links to.
    lookupTarget: Joi.when('type', {
      is: 'lookup',
      then: object.required(),
      otherwise: Joi.forbidden().messages({ 'any.unknown': 'Only a link field links to records.' }),
    }),
  }),
  fieldPatch: Joi.object({
    label,
    helpText,
    required: Joi.boolean(),
    sectionId,
    access,
    listColumn: Joi.boolean(),
    options: Joi.array().items(option).min(1).max(MAX_OPTIONS),
    version: Joi.number().integer().min(0),
    object: fixed('A field cannot move to another page. Add a new field instead.'),
    key: fixed('The key of a field never changes.'),
    type: fixed('The type of a field cannot change. Add a new field instead.'),
    lookupTarget: fixed('What a link field links to cannot change. Add a new field instead.'),
  }).min(1),
  fieldReorder: Joi.object({
    object: object.required(),
    ids: Joi.array().items(objectId).min(1).max(MAX_ACTIVE_FIELDS).required(),
  }),
  // Sections (D76). The whole list in order: a section without an id is new, one left out is
  // removed. fieldIds: exactly the fields in that section from now on (optional). More than
  // MAX_SECTIONS gets 422 SECTION_LIMIT in the service, so the message can say what to do.
  layoutGet: Joi.object({ object: object.required() }),
  layoutPut: Joi.object({
    object: object.required(),
    sections: Joi.array().items(Joi.object({
      id: Joi.string().pattern(SECTION_ID_PATTERN).messages({ 'string.pattern.base': 'Unknown section' }),
      label: Joi.string().trim().min(1).max(SECTION_LABEL_MAX).required(),
      columns: Joi.number().valid(1, 2).default(1),
      fieldIds: Joi.array().items(objectId).max(MAX_ACTIVE_FIELDS),
    })).max(MAX_SECTIONS * 5).required(),
    version: Joi.number().integer().min(0),
  }),

  // --- the company's own objects (D75) ---
  objectList: Joi.object({ status: Joi.string().valid('active', 'all').default('active') }),
  objectCreate: Joi.object({
    singular: objectName.required(),
    plural: objectName.required(),
    icon: Joi.string().valid(...OBJECT_ICONS).default('box'),
  }),
  objectPatch: Joi.object({
    singular: objectName,
    plural: objectName,
    icon: Joi.string().valid(...OBJECT_ICONS),
    version: Joi.number().integer().min(0),
    key: fixed('The key of an object never changes.'),
  }).min(1),
  objectReorder: Joi.object({ ids: Joi.array().items(objectId).min(1).max(MAX_CUSTOM_OBJECTS).required() }),

  // --- their records ---
  recordList: Joi.object({
    ...paginationQuery,
    object: objectKey,
    contactId: objectId,
    q: Joi.string().trim().max(100).allow(''),
    sort: Joi.string().max(40),
    cf: fieldFilters,
  }).or('object', 'contactId'),
  recordCreate: Joi.object({
    object: objectKey.required(),
    name: Joi.string().trim().min(1).max(200).required(),
    contactId: objectId.allow(null),
    ownerId: objectId.allow(null),
    customFields: customFieldValues,
  }),
  recordPatch: Joi.object({
    name: Joi.string().trim().min(1).max(200),
    contactId: objectId.allow(null),
    ownerId: objectId.allow(null),
    customFields: customFieldValues,
    version: Joi.number().integer().min(0),
    object: fixed('A record cannot move to another object.'),
  }).min(1),

  // The link picker: GET /lookup?target=&q= (or &id= for the name of one chosen record, D99)
  lookupQuery: Joi.object({
    target: object.required(),
    q: Joi.string().trim().max(100).allow(''),
    id: objectId,
    limit: Joi.number().integer().min(1).max(20).default(20),
  }),
};
