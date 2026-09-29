const AutoReplyRule = require('../models/AutoReplyRule');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const MessageTemplate = require('../models/MessageTemplate');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const httpError = require('../utils/httpError');
const logger = require('../config/logger');
const { audit } = require('../utils/audit');
const templateService = require('./templateService');
const conversations = require('./conversationService');

// Auto-reply rules (Phase 4): a lead from a chosen source gets an approved WhatsApp template
// within seconds (the brief asks for under 60), sent by the CRM itself in the lead's chat.
// Skipped, with the reason on the lead: repeat enquiries (unless the rule says otherwise),
// enquiries older than the rule's limit, no mobile number, a template no longer approved,
// marketing templates to people who opted out.
const JOB = 'lead.autoreply';
const VALUES = ['contact.name', 'contact.company', 'contact.city', 'lead.product', 'owner.name', 'org.name'];
const validValue = (value) => VALUES.includes(value) || /^text:.{1,200}$/s.test(value);

// The rule for a lead: the first active one (by priority) that includes its source.
async function ruleFor(lead, source = lead.source) {
  const rules = await AutoReplyRule.find({ organizationId: lead.organizationId, active: true }).sort({ priority: 1, createdAt: 1 });
  return rules.find((rule) => !rule.sources.length || rule.sources.includes(source)) || null;
}

async function note(lead, text) {
  await LeadActivity.create({ organizationId: lead.organizationId, leadId: lead._id, contactId: lead.contactId, type: 'Auto-reply', text, actorName: 'Auto-reply' });
}
async function count(rule, outcome) {
  await AutoReplyRule.updateOne({ _id: rule._id }, { $inc: { [`stats.${outcome}`]: 1 }, ...(outcome === 'sent' && { $set: { 'stats.lastSentAt': new Date() } }) });
}

// After assignment: schedules the auto-reply of one enquiry, or records why there is none.
async function schedule(queue, lead, { source, contactCreated, receivedAt, sourceRef }) {
  const rule = await ruleFor(lead, source);
  if (!rule) return null;
  if (rule.onlyNewContacts && !contactCreated) {
    await count(rule, 'skipped');
    return null;
  }
  const age = Date.now() - new Date(receivedAt || Date.now()).getTime();
  if (rule.maxAgeMinutes && age > rule.maxAgeMinutes * 60 * 1000) {
    await count(rule, 'skipped');
    await note(lead, `No auto-reply: the enquiry is older than ${rule.maxAgeMinutes} minutes.`);
    return null;
  }
  return queue.enqueue(JOB, { leadId: String(lead._id), ruleId: String(rule._id) }, {
    runAt: new Date(Date.now() + rule.delaySeconds * 1000), uniqueKey: `autoreply:${lead._id}:${sourceRef || 'lead'}`, organizationId: lead.organizationId, maxAttempts: 3,
  });
}

async function resolveVariables(rule, { contact, lead, organization, owner }) {
  const valueOf = (spec) => {
    if (String(spec).startsWith('text:')) return String(spec).slice(5);
    return {
      'contact.name': contact.name, 'contact.company': contact.company, 'contact.city': contact.city,
      'lead.product': lead.title, 'owner.name': owner, 'org.name': organization?.name,
    }[spec] || '';
  };
  const out = {};
  for (const part of ['header', 'body', 'buttons']) {
    out[part] = Object.fromEntries(Object.entries(rule.variables?.[part] || {}).map(([name, spec]) => [name, valueOf(spec)]));
  }
  return out;
}

async function send({ leadId, ruleId }) {
  const rule = await AutoReplyRule.findOne({ _id: ruleId, active: true });
  const lead = await Lead.findById(leadId);
  if (!rule || !lead) return;
  const skip = async (why) => {
    await count(rule, 'skipped');
    await note(lead, `No auto-reply: ${why}`);
  };
  const contact = await Contact.findById(lead.contactId);
  if (!contact?.phoneE164) return skip('the customer has no mobile number.');
  const template = await MessageTemplate.findOne({ _id: rule.templateId, organizationId: lead.organizationId });
  if (!template || template.status !== 'APPROVED') return skip('the template is not approved (any more).');
  if (template.category === 'MARKETING' && contact.consent?.marketing === 'opted_out') return skip('the customer opted out of marketing messages.');
  const account = await WhatsAppAccount.findOne({ _id: template.whatsappAccountId, organizationId: lead.organizationId });
  if (!account) return skip('the template\'s WhatsApp number was removed.');

  const [organization, ownerMember] = await Promise.all([
    Organization.findById(lead.organizationId).select('name'),
    lead.ownerId ? OrganizationMember.findById(lead.ownerId).populate('userId', 'name') : null,
  ]);
  const variables = await resolveVariables(rule, { contact, lead, organization, owner: ownerMember?.displayName || ownerMember?.userId?.name || '' });
  const conversation = await conversations.ensureConversation({ organizationId: lead.organizationId, contactId: contact._id, accountId: account._id, assigneeId: lead.ownerId || null });
  let message;
  try {
    message = await conversations.sendTemplateAutomatically({ conversation, template, variables, automation: { kind: 'auto-reply', ruleId: rule._id } });
  } catch (error) {
    // A variable that cannot be filled (e.g. no name) or a missing number: nothing to retry.
    if (error.statusCode && error.statusCode < 500) return skip(error.message);
    throw error;
  }
  if (message.status === 'failed') {
    await count(rule, 'failed');
    await note(lead, `Auto-reply "${template.name}" was not sent: ${message.error?.message || 'WhatsApp refused it'}.`);
    return;
  }
  await count(rule, 'sent');
  await note(lead, `Sent WhatsApp template "${template.name}".`);
  logger.info(`Auto-reply ${template.name} sent for lead ${lead._id}`);
}

// --- rules (Settings, owners and admins) -------------------------------------------------
function serializeRule(rule) {
  return {
    id: rule._id, name: rule.name, active: rule.active, priority: rule.priority, sources: rule.sources,
    onlyNewContacts: rule.onlyNewContacts, maxAgeMinutes: rule.maxAgeMinutes, delaySeconds: rule.delaySeconds,
    templateId: rule.templateId, variables: rule.variables, stats: rule.stats, createdAt: rule.createdAt,
  };
}

// The template must belong to the organization, and every one of its variables needs a value.
async function checkTemplate(req, templateId, variables = {}) {
  const template = await MessageTemplate.findOne({ _id: templateId, organizationId: req.tenant.organizationId });
  if (!template) throw httpError(400, 'VALIDATION_ERROR', 'Pick one of your WhatsApp templates.', [{ field: 'templateId', code: 'INVALID_TEMPLATE', message: 'Pick one of your WhatsApp templates.' }]);
  const shape = templateService.shapeOf(template);
  const needed = [
    ...(shape.header?.variables || []).map((name) => ['header', name]),
    ...shape.body.variables.map((name) => ['body', name]),
    ...shape.buttons.filter((b) => b.variables.length).map((b) => ['buttons', String(b.index)]),
  ];
  for (const [part, name] of needed) {
    const spec = variables?.[part]?.[name];
    if (!spec || !validValue(spec)) {
      throw httpError(400, 'VALIDATION_ERROR', `Choose what fills {{${name}}}.`, [{ field: `variables.${part}.${name}`, code: 'VARIABLE_REQUIRED', message: `Choose what fills {{${name}}}.` }]);
    }
  }
  return template;
}

async function findRule(req, id) {
  const rule = await AutoReplyRule.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!rule) throw httpError(404, 'NOT_FOUND', 'Auto-reply rule not found');
  return rule;
}

async function listRules(req) {
  return (await AutoReplyRule.find({ organizationId: req.tenant.organizationId }).sort({ priority: 1, createdAt: 1 })).map(serializeRule);
}

async function createRule(req, body) {
  await checkTemplate(req, body.templateId, body.variables);
  const rule = await AutoReplyRule.create({ ...body, organizationId: req.tenant.organizationId, createdById: req.user._id });
  await audit(req, { action: 'autoreplyrule.created', entityType: 'AutoReplyRule', entityId: rule._id });
  return serializeRule(rule);
}

async function updateRule(req, id, body) {
  const rule = await findRule(req, id);
  for (const key of ['name', 'active', 'priority', 'sources', 'onlyNewContacts', 'maxAgeMinutes', 'delaySeconds', 'templateId', 'variables']) {
    if (key in body) rule[key] = body[key];
  }
  await checkTemplate(req, rule.templateId, rule.variables);
  rule.markModified('variables');
  await rule.save();
  await audit(req, { action: 'autoreplyrule.updated', entityType: 'AutoReplyRule', entityId: rule._id, changes: Object.keys(body) });
  return serializeRule(rule);
}

async function removeRule(req, id) {
  const rule = await findRule(req, id);
  await rule.deleteOne();
  await audit(req, { action: 'autoreplyrule.deleted', entityType: 'AutoReplyRule', entityId: rule._id });
}

module.exports = { JOB, VALUES, schedule, send, ruleFor, listRules, createRule, updateRule, removeRule, serializeRule };
