const BotSettings = require('../models/BotSettings');
const FaqRule = require('../models/FaqRule');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');

// The WhatsApp FAQ bot's settings and answers (Sales Automation → FAQ bot, owners and admins).
// What the bot does with a message: automation/bot.js.

function serializeAnswer(answer = {}) {
  return {
    text: answer.text || '',
    options: (answer.options || []).map((o) => ({ title: o.title, description: o.description || '', action: o.action, ...(o.ruleId && { ruleId: o.ruleId }) })),
    listButton: answer.listButton || 'Choose',
    footer: answer.footer || '',
  };
}

function serializeRule(rule) {
  return {
    id: rule._id, name: rule.name, active: rule.active, priority: rule.priority, keywords: rule.keywords,
    answer: serializeAnswer(rule.answer), stats: { answered: rule.stats?.answered || 0, lastAnsweredAt: rule.stats?.lastAnsweredAt || null },
    createdAt: rule.createdAt, updatedAt: rule.updatedAt,
  };
}

function serializeSettings(settings) {
  return {
    enabled: settings.enabled,
    greeting: { enabled: settings.greeting.enabled, answer: serializeAnswer(settings.greeting.answer) },
    away: { enabled: settings.away.enabled, answer: serializeAnswer(settings.away.answer) },
    handoff: { keywords: settings.handoff.keywords, text: settings.handoff.text },
    repeatAfterHours: settings.repeatAfterHours,
    updatedAt: settings.updatedAt || null,
  };
}

// Options may only open answers of this organization.
async function checkOptions(req, answers) {
  for (const [field, answer] of answers) {
    for (const [index, option] of (answer?.options || []).entries()) {
      if (option.action !== 'rule') continue;
      if (!(await FaqRule.exists({ _id: option.ruleId, organizationId: req.tenant.organizationId }))) {
        const message = `Option "${option.title}" must open one of your answers.`;
        throw httpError(400, 'VALIDATION_ERROR', message, [{ field: `${field}.options.${index}.ruleId`, code: 'INVALID_RULE', message }]);
      }
    }
  }
}

// --- settings ------------------------------------------------------------------------------
async function status(req) {
  return { enabled: Boolean(await BotSettings.exists({ organizationId: req.tenant.organizationId, enabled: true })) };
}

async function getSettings(req) {
  const settings = (await BotSettings.findOne({ organizationId: req.tenant.organizationId })) || new BotSettings({ organizationId: req.tenant.organizationId });
  return serializeSettings(settings);
}

async function saveSettings(req, body) {
  await checkOptions(req, [['greeting.answer', body.greeting?.answer], ['away.answer', body.away?.answer]]);
  const settings = (await BotSettings.findOne({ organizationId: req.tenant.organizationId })) || new BotSettings({ organizationId: req.tenant.organizationId });
  if ('enabled' in body) settings.enabled = body.enabled;
  if ('repeatAfterHours' in body) settings.repeatAfterHours = body.repeatAfterHours;
  for (const part of ['greeting', 'away']) {
    if (!body[part]) continue;
    if ('enabled' in body[part]) settings.set(`${part}.enabled`, body[part].enabled);
    if (body[part].answer) settings.set(`${part}.answer`, body[part].answer);
  }
  if (body.handoff) {
    if (body.handoff.keywords) settings.set('handoff.keywords', [...new Set(body.handoff.keywords.map((k) => k.trim()).filter(Boolean))]);
    if ('text' in body.handoff) settings.set('handoff.text', body.handoff.text);
  }
  await settings.save();
  await audit(req, { action: 'bot.settings_saved', entityType: 'BotSettings', entityId: settings._id, changes: Object.keys(body) });
  return serializeSettings(settings);
}

// --- answers (FAQ rules) -------------------------------------------------------------------
async function findRule(req, id) {
  const rule = await FaqRule.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!rule) throw httpError(404, 'NOT_FOUND', 'Answer not found');
  return rule;
}

async function listRules(req) {
  return (await FaqRule.find({ organizationId: req.tenant.organizationId }).sort({ priority: 1, createdAt: 1 })).map(serializeRule);
}

async function createRule(req, body) {
  await checkOptions(req, [['answer', body.answer]]);
  const rule = await FaqRule.create({ ...body, organizationId: req.tenant.organizationId, createdById: req.user._id });
  await audit(req, { action: 'faqrule.created', entityType: 'FaqRule', entityId: rule._id });
  return serializeRule(rule);
}

async function updateRule(req, id, body) {
  const rule = await findRule(req, id);
  if (body.answer) await checkOptions(req, [['answer', body.answer]]);
  for (const key of ['name', 'active', 'priority', 'keywords', 'answer']) if (key in body) rule.set(key, body[key]);
  await rule.save();
  await audit(req, { action: 'faqrule.updated', entityType: 'FaqRule', entityId: rule._id, changes: Object.keys(body) });
  return serializeRule(rule);
}

// Options pointing to a removed answer simply stop showing (automation/bot.js leaves them out).
async function removeRule(req, id) {
  const rule = await findRule(req, id);
  await rule.deleteOne();
  await audit(req, { action: 'faqrule.deleted', entityType: 'FaqRule', entityId: rule._id });
}

module.exports = { status, getSettings, saveSettings, listRules, createRule, updateRule, removeRule, serializeRule, serializeSettings };
