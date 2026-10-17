const Joi = require('joi');
const { objectId } = require('./common');
const {
  CUSTOM_FIELD_OBJECTS, CUSTOM_FIELD_TYPES, MAX_ACTIVE_FIELDS, MAX_OPTIONS, LABEL_MAX, HELP_TEXT_MAX, MAX_FILTERS,
} = require('../constants/customFields');

// Settings → Custom fields (D73). Values on records: customFieldValues in validators/crm.js.
const object = Joi.string().valid(...CUSTOM_FIELD_OBJECTS);
const label = Joi.string().trim().min(1).max(LABEL_MAX);
const helpText = Joi.string().trim().max(HELP_TEXT_MAX).allow('');
const fixed = (message) => Joi.any().forbidden().messages({ 'any.unknown': message });
const newOption = Joi.object({ label: label.required() });
const option = Joi.object({ value: Joi.string().trim().max(10), label: label.required(), archived: Joi.boolean() });

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
  // The public API's list of fields (D74).
  publicFieldList: Joi.object({ object: object.required() }),
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
    listColumn: Joi.boolean(),
    options: Joi.when('type', {
      is: 'dropdown',
      then: Joi.array().items(newOption).min(1).max(MAX_OPTIONS).required(),
      otherwise: Joi.forbidden().messages({ 'any.unknown': 'Only a dropdown has choices.' }),
    }),
  }),
  fieldPatch: Joi.object({
    label,
    helpText,
    required: Joi.boolean(),
    listColumn: Joi.boolean(),
    options: Joi.array().items(option).min(1).max(MAX_OPTIONS),
    version: Joi.number().integer().min(0),
    object: fixed('A field cannot move to another page. Add a new field instead.'),
    key: fixed('The key of a field never changes.'),
    type: fixed('The type of a field cannot change. Add a new field instead.'),
  }).min(1),
  fieldReorder: Joi.object({
    object: object.required(),
    ids: Joi.array().items(objectId).min(1).max(MAX_ACTIVE_FIELDS).required(),
  }),
};
