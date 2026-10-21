const Joi = require('joi');
const { APPROVAL_ROLES, RULE_NAME_MAX } = require('../constants/approvals');

// Settings → Approvals (D77): limits on quotations. At least one condition is checked in the
// service (a patch may take one away), so the message can say what to do.
const name = Joi.string().trim().min(1).max(RULE_NAME_MAX);
const percent = Joi.number().min(0).max(100).precision(2);
const paise = Joi.number().integer().min(0).max(1e13);
const appliesTo = Joi.array().items(Joi.string().valid(...APPROVAL_ROLES)).unique().min(1)
  .custom((roles) => (roles.includes('agent') ? roles : [...roles, 'agent']), 'agents always');

module.exports = {
  ruleList: Joi.object({ status: Joi.string().valid('active', 'all').default('active') }),
  ruleCreate: Joi.object({
    name: name.required(),
    discountPercentAbove: percent.allow(null),
    grandTotalAbovePaise: paise.allow(null),
    appliesTo: appliesTo.default(['agent']),
  }),
  rulePatch: Joi.object({
    name,
    discountPercentAbove: percent.allow(null),
    grandTotalAbovePaise: paise.allow(null),
    appliesTo,
    version: Joi.number().integer().min(0),
  }).min(1),
};
