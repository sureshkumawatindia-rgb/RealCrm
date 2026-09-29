const AssignmentRule = require('../models/AssignmentRule');
const AssignmentHistory = require('../models/AssignmentHistory');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const httpError = require('../utils/httpError');
const bus = require('../realtime/bus');
const { audit } = require('../utils/audit');
const { isManager } = require('../constants/permissions');
const { businessHoursOf, isOpen } = require('../utils/businessHours');

// Assignment rules (Phase 4): who owns a new lead. The first active rule (by priority) whose
// conditions all match decides: round-robin among its people, or one specific person. With
// "respect working hours", a lead outside the organization's hours goes to the fallback person
// (or stays unassigned). People who left, were disabled or cannot open Leads are skipped.
const norm = (value) => String(value || '').trim().toLowerCase();
const canTakeLeads = (member) => member.status === 'active' && (isManager(member) || member.modules?.some((m) => m === 'leads' || m === 'deals'));

function matches(rule, facts) {
  const { sources, productIds, states, cities } = rule.conditions || {};
  if (sources?.length && !sources.includes(facts.source)) return false;
  if (productIds?.length && !productIds.some((id) => String(id) === facts.productId)) return false;
  if (states?.length && !states.map(norm).includes(facts.state)) return false;
  if (cities?.length && !cities.map(norm).includes(facts.city)) return false;
  return true;
}

async function usableMembers(organizationId, ids) {
  if (!ids?.length) return [];
  const members = await OrganizationMember.find({ _id: { $in: ids }, organizationId });
  const byId = new Map(members.filter(canTakeLeads).map((m) => [String(m._id), m]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean); // the rule's own order
}

// → { memberId|null, ruleId|null, reason }
async function pickOwner(lead, contact, { source, now = new Date() } = {}) {
  const organizationId = lead.organizationId;
  const rules = await AssignmentRule.find({ organizationId, active: true }).sort({ priority: 1, createdAt: 1 });
  const facts = { source: source || lead.source, productId: String(lead.productId || ''), state: norm(contact?.state), city: norm(contact?.city) };
  const rule = rules.find((candidate) => matches(candidate, facts));
  if (!rule) return { memberId: null, ruleId: null, reason: 'No assignment rule matched' };
  const label = `rule "${rule.name || 'unnamed'}"`;

  const fallback = async (why) => {
    const [member] = await usableMembers(organizationId, rule.fallbackMemberId ? [rule.fallbackMemberId] : []);
    return member
      ? { memberId: member._id, ruleId: rule._id, reason: `${label}: ${why}, so the fallback person` }
      : { memberId: null, ruleId: rule._id, reason: `${label}: ${why}, and there is no fallback person` };
  };

  if (rule.respectWorkingHours) {
    const organization = await Organization.findById(organizationId).select('businessHours');
    if (!isOpen(businessHoursOf(organization), now)) return fallback('outside working hours');
  }
  const pool = await usableMembers(organizationId, rule.memberIds);
  if (!pool.length) return fallback('nobody in the rule can take leads');
  if (rule.strategy === 'specific') return { memberId: pool[0]._id, ruleId: rule._id, reason: label };
  // One atomic step per lead: two leads at the same moment get different people.
  const turn = await AssignmentRule.findOneAndUpdate({ _id: rule._id }, { $inc: { rrCounter: 1 } }, { returnDocument: 'before' });
  const member = pool[turn.rrCounter % pool.length];
  return { memberId: member._id, ruleId: rule._id, reason: `${label} (round-robin)` };
}

// Gives an unowned lead (and its unowned contact and unassigned chats) to the chosen person.
async function assignLead(lead, contact, decision) {
  const organizationId = lead.organizationId;
  await AssignmentHistory.create({
    organizationId, entityId: lead._id, contactId: lead.contactId, fromMemberId: lead.ownerId || undefined,
    toMemberId: decision.memberId || undefined, ruleId: decision.ruleId || undefined, reason: decision.reason,
  });
  if (!decision.memberId) return false;
  const updated = await Lead.updateOne({ _id: lead._id, ownerId: null }, { $set: { ownerId: decision.memberId } });
  if (!updated.modifiedCount) return false; // someone took it meanwhile
  await Contact.updateOne({ _id: lead.contactId, ownerId: null }, { $set: { ownerId: decision.memberId } });
  const chats = await Conversation.find({ organizationId, contactId: lead.contactId, assigneeId: null });
  for (const chat of chats) {
    const assigned = await Conversation.findOneAndUpdate({ _id: chat._id, assigneeId: null }, { $set: { assigneeId: decision.memberId } }, { returnDocument: 'after' });
    if (assigned) bus.emit('conversation:updated', { organizationId, conversation: assigned, previousAssigneeId: null });
  }
  const member = await OrganizationMember.findById(decision.memberId).populate('userId', 'name');
  await LeadActivity.create({
    organizationId, leadId: lead._id, contactId: lead.contactId, type: 'Assigned',
    text: `Assigned to ${member?.displayName || member?.userId?.name || 'a teammate'} by ${decision.reason}`, actorName: 'Assignment rules',
  });
  if (decision.ruleId) await AssignmentRule.updateOne({ _id: decision.ruleId }, { $inc: { 'stats.assigned': 1 }, $set: { 'stats.lastAssignedAt': new Date() } });
  return true;
}

// --- rules (Settings, owners and admins) -------------------------------------------------
function serializeRule(rule) {
  return {
    id: rule._id,
    name: rule.name,
    active: rule.active,
    priority: rule.priority,
    conditions: {
      sources: rule.conditions?.sources || [], productIds: rule.conditions?.productIds || [],
      states: rule.conditions?.states || [], cities: rule.conditions?.cities || [],
    },
    strategy: rule.strategy,
    memberIds: rule.memberIds,
    respectWorkingHours: rule.respectWorkingHours,
    fallbackMemberId: rule.fallbackMemberId || null,
    stats: rule.stats,
    createdAt: rule.createdAt,
  };
}

async function checkMembers(req, ids = []) {
  if (!ids.length) return;
  const found = await OrganizationMember.countDocuments({ _id: { $in: ids }, organizationId: req.tenant.organizationId });
  if (found !== new Set(ids.map(String)).size) throw httpError(400, 'VALIDATION_ERROR', 'Pick people from your team.', [{ field: 'memberIds', code: 'INVALID_MEMBER', message: 'Pick people from your team.' }]);
}

async function findRule(req, id) {
  const rule = await AssignmentRule.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!rule) throw httpError(404, 'NOT_FOUND', 'Assignment rule not found');
  return rule;
}

async function listRules(req) {
  return (await AssignmentRule.find({ organizationId: req.tenant.organizationId }).sort({ priority: 1, createdAt: 1 })).map(serializeRule);
}

async function createRule(req, body) {
  await checkMembers(req, [...(body.memberIds || []), ...(body.fallbackMemberId ? [body.fallbackMemberId] : [])]);
  const rule = await AssignmentRule.create({ ...body, organizationId: req.tenant.organizationId, createdById: req.user._id });
  await audit(req, { action: 'assignmentrule.created', entityType: 'AssignmentRule', entityId: rule._id });
  return serializeRule(rule);
}

async function updateRule(req, id, body) {
  const rule = await findRule(req, id);
  await checkMembers(req, [...(body.memberIds || []), ...(body.fallbackMemberId ? [body.fallbackMemberId] : [])]);
  for (const key of ['name', 'active', 'priority', 'strategy', 'memberIds', 'respectWorkingHours', 'fallbackMemberId']) {
    if (key in body) rule[key] = body[key];
  }
  if (body.conditions) rule.conditions = { ...rule.conditions.toObject(), ...body.conditions };
  await rule.save();
  await audit(req, { action: 'assignmentrule.updated', entityType: 'AssignmentRule', entityId: rule._id, changes: Object.keys(body) });
  return serializeRule(rule);
}

async function removeRule(req, id) {
  const rule = await findRule(req, id);
  await rule.deleteOne();
  await audit(req, { action: 'assignmentrule.deleted', entityType: 'AssignmentRule', entityId: rule._id });
}

// The automatic assignments of one lead (newest first).
async function history(req, leadId) {
  const items = await AssignmentHistory.find({ organizationId: req.tenant.organizationId, entityType: 'Lead', entityId: leadId }).sort({ createdAt: -1 }).limit(50);
  return items.map((h) => ({ id: h._id, toMemberId: h.toMemberId || null, fromMemberId: h.fromMemberId || null, ruleId: h.ruleId || null, reason: h.reason, at: h.createdAt }));
}

// --- working hours -----------------------------------------------------------------------
async function getBusinessHours(req) {
  const organization = await Organization.findById(req.tenant.organizationId).select('businessHours');
  const hours = businessHoursOf(organization);
  return { ...hours, openNow: isOpen(hours) };
}

async function setBusinessHours(req, body) {
  await Organization.updateOne({ _id: req.tenant.organizationId }, { $set: { businessHours: body } });
  await audit(req, { action: 'organization.businesshours.updated', entityType: 'Organization', entityId: req.tenant.organizationId });
  return getBusinessHours(req);
}

module.exports = {
  pickOwner, assignLead, matches, listRules, createRule, updateRule, removeRule, history, getBusinessHours, setBusinessHours, serializeRule,
};
