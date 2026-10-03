const Joi = require('joi');
const { objectId } = require('./common');
const { paginationQuery } = require('../utils/pagination');
const { ORDER_STAGES } = require('../constants/crm');

const text = (max) => Joi.string().trim().max(max).allow('');
const dispatch = Joi.object({
  transporter: text(120),
  lrNumber: text(60),
  vehicleNumber: text(20),
  expectedDeliveryDate: Joi.date().allow(null, '').empty(''),
});
const variables = Joi.object({
  header: Joi.object().pattern(/^[A-Za-z0-9_]{1,60}$/, Joi.string().allow('').max(1024)),
  body: Joi.object().pattern(/^[A-Za-z0-9_]{1,60}$/, Joi.string().allow('').max(1024)),
  buttons: Joi.object().pattern(/^\d{1,2}$/, Joi.string().allow('').max(1024)),
});

module.exports = {
  orderCreate: Joi.object({ quotationId: objectId.required() }),
  orderPatch: Joi.object({ dispatch, notes: text(2000) }).min(1),
  orderStage: Joi.object({
    stage: Joi.string().valid(...ORDER_STAGES).required(),
    note: text(500),
    cancelReason: text(500),
    dispatch,
  }),
  // A WhatsApp update: a text while the 24-hour window is open, else an approved template.
  orderNotify: Joi.object({
    mode: Joi.string().valid('text', 'template').required(),
    text: Joi.when('mode', { is: 'text', then: Joi.string().trim().min(1).max(4096).required(), otherwise: Joi.forbidden() }),
    templateId: Joi.when('mode', { is: 'template', then: objectId.required(), otherwise: Joi.forbidden() }),
    variables: Joi.when('mode', { is: 'template', then: variables.default({}), otherwise: Joi.forbidden() }),
  }),
  orderList: Joi.object({
    ...paginationQuery,
    stage: Joi.string().valid(...ORDER_STAGES),
    contactId: objectId,
    leadId: objectId,
    q: Joi.string().trim().max(100).allow(''),
  }),
  awaitingReply: Joi.object({ days: Joi.number().integer().min(1).max(60).default(3) }),
};
