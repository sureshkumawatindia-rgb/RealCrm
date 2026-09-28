const Joi = require('joi');
const { ROLES, INVITABLE_ROLES, MODULES, PERMISSION_PATTERN } = require('../constants/permissions');
const { paginationQuery } = require('../utils/pagination');

const modules = Joi.array().items(Joi.string().valid(...MODULES)).unique();
const permissions = Joi.array().items(Joi.string().pattern(PERMISSION_PATTERN)).unique();
const displayName = Joi.string().trim().max(100).allow('');
const mobile = Joi.string().trim().max(30).allow('');
const title = Joi.string().trim().max(60).allow('');

module.exports = {
  memberPatch: Joi.object({
    role: Joi.string().valid(...ROLES),
    modules,
    permissions,
    status: Joi.string().valid('active', 'disabled'),
    displayName,
    mobile,
    title,
    assignable: Joi.boolean(),
  }).min(1),
  inviteCreate: Joi.object({
    email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254).required(),
    role: Joi.string().valid(...INVITABLE_ROLES).required(),
    modules,
    permissions,
    displayName,
    mobile,
    title,
  }),
  inviteList: Joi.object({
    ...paginationQuery,
    status: Joi.string().valid('pending', 'accepted', 'revoked', 'all').default('pending'),
  }),
  inviteLookup: Joi.object({
    token: Joi.string().max(200).required(),
  }),
};
