const Joi = require('joi');
const { objectId } = require('./common');

const phone = Joi.string().trim().min(6).max(30).required();
const code = Joi.string().trim().pattern(/^\d{6}$/).required().messages({ 'string.pattern.base': 'The code has 6 digits.' });
const challenge = Joi.string().max(2000).required();
const secret = Joi.string().pattern(/^[A-Za-z0-9_-]{20,100}$/).required();

module.exports = {
  googleLogin: Joi.object({
    credential: Joi.string().max(8192).required(),
    inviteToken: Joi.string().max(200).allow(''),
  }),
  switchOrganization: Joi.object({
    organizationId: objectId.required(),
  }),
  // One's own WhatsApp number (Phase 10E).
  otpRequest: Joi.object({ phone }),
  otpVerify: Joi.object({ phone, code }),
  // Signing in after Google, and from the phone by QR (D58).
  loginCode: Joi.object({ challenge, phone, channel: Joi.string().valid('whatsapp', 'sms').default('whatsapp') }),
  loginVerify: Joi.object({ challenge, phone, code, stayLoggedIn: Joi.boolean().default(false) }),
  qrPoll: Joi.object({ secret, stayLoggedIn: Joi.boolean().default(false) }),
  qrSecret: Joi.object({ secret }),
  qrApprove: Joi.object({ secret, allow: Joi.boolean().default(true) }),
  // "Where you're logged in": a session family id (a UUID).
  deviceParams: Joi.object({ id: Joi.string().guid().required() }),
};
