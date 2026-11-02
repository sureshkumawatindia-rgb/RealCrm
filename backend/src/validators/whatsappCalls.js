const Joi = require('joi');
const { objectId } = require('./common');

// WhatsApp calls (G7, D111). sdp: the audio set-up the browser made for the call (RFC 8866),
// passed to WhatsApp as it is (its line breaks included).
const sdp = Joi.string().min(20).max(20000).pattern(/^v=0\r?\n/).required();

module.exports = {
  place: Joi.object({ conversationId: objectId.required(), sdp }),
  answer: Joi.object({ sdp }),
  // The words of the request to call, in the customer's chat.
  permission: Joi.object({ conversationId: objectId.required(), text: Joi.string().trim().min(1).max(1024).required() }),
};
