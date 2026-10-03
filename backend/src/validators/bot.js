const Joi = require('joi');
const { objectId } = require('./common');

// The WhatsApp FAQ bot (Phase 6C). WhatsApp's limits: up to 3 reply buttons (titles ≤ 20
// characters, unique) or a list of up to 10 rows (titles ≤ 24, descriptions ≤ 72, the list's
// button ≤ 20); footer ≤ 60. The body is kept ≤ 1024 for both.
const option = Joi.object({
  title: Joi.string().trim().min(1).max(24).required().label('Option title'),
  description: Joi.string().trim().max(72).allow('').label('Option description'),
  action: Joi.string().valid('rule', 'handoff').required(),
  ruleId: Joi.when('action', { is: 'rule', then: objectId.required().label('Answer of the option'), otherwise: Joi.any().strip() }),
});

const answer = Joi.object({
  text: Joi.string().trim().min(1).max(1024).required().label('Message'),
  options: Joi.array().items(option).max(10).default([]),
  listButton: Joi.string().trim().min(1).max(20).default('Choose').label('List button'),
  footer: Joi.string().trim().max(60).allow('').default('').label('Footer'),
}).custom((value, helpers) => {
  const titles = value.options.map((o) => o.title.toLowerCase());
  if (new Set(titles).size !== titles.length) return helpers.message('Each option needs a different title.');
  if (value.options.length <= 3 && value.options.some((o) => o.title.length > 20)) {
    return helpers.message('With 1 to 3 options they are buttons: keep each title to 20 characters.');
  }
  return value;
});

const keywords = Joi.array().items(Joi.string().trim().min(1).max(60)).max(30);

const ruleFields = {
  name: Joi.string().trim().min(1).max(100),
  active: Joi.boolean(),
  priority: Joi.number().integer().min(0).max(10000),
  keywords,
  answer,
};

module.exports = {
  faqRuleCreate: Joi.object({ ...ruleFields, name: ruleFields.name.required(), answer: answer.required() }),
  faqRulePatch: Joi.object(ruleFields).min(1),
  botSettings: Joi.object({
    enabled: Joi.boolean(),
    greeting: Joi.object({ enabled: Joi.boolean(), answer }),
    away: Joi.object({ enabled: Joi.boolean(), answer }),
    handoff: Joi.object({ keywords, text: Joi.string().trim().max(1024).allow('') }),
    repeatAfterHours: Joi.number().integer().min(1).max(168),
  }).min(1),
  botSwitch: Joi.object({ active: Joi.boolean().required() }),
};
