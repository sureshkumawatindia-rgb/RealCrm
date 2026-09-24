const Joi = require('joi');
const { objectId } = require('./common');

module.exports = {
  googleLogin: Joi.object({
    credential: Joi.string().max(8192).required(),
    inviteToken: Joi.string().max(200).allow(''),
  }),
  switchOrganization: Joi.object({
    organizationId: objectId.required(),
  }),
};
