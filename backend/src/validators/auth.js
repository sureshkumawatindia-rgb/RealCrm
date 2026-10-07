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
  // Phone sign-in with a WhatsApp code (Phase 10E).
  otpRequest: Joi.object({ phone: Joi.string().trim().min(6).max(30).required() }),
  otpVerify: Joi.object({
    phone: Joi.string().trim().min(6).max(30).required(),
    code: Joi.string().trim().pattern(/^\d{6}$/).required().messages({ 'string.pattern.base': 'The code has 6 digits.' }),
  }),
};
