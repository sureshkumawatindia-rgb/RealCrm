const OrganizationMember = require('../models/OrganizationMember');
const httpError = require('../utils/httpError');
const { isManager, canViewAll } = require('../constants/permissions');

const asList = (modules) => (Array.isArray(modules) ? modules : [modules]);

// Private numbers (D61): contacts, leads and chats of numbers an owner made private are seen by
// owners only — not by admins, agents or viewers. Added next to visibilityFilter where those
// three are read (visibilityFilter itself stays "empty = sees everything").
const isOwner = (req) => req.member?.role === 'owner';
const privacyFilter = (req) => (isOwner(req) ? {} : { private: { $ne: true } });

// Record scope (D17): agents and viewers see only records they own, unless they have
// "<module>:view_all" for one of the modules.
function visibilityFilter(req, modules, ownerField = 'ownerId') {
  if (asList(modules).some((module) => canViewAll(req.member, module))) return {};
  return { [ownerField]: req.member._id };
}

// Work items (tasks, events): a member without view_all sees what is assigned to them or
// what they created.
function assignedOrCreatedFilter(req, modules) {
  if (asList(modules).some((module) => canViewAll(req.member, module))) return {};
  return { $or: [{ assigneeId: req.member._id }, { createdByMemberId: req.member._id }] };
}

// Any member may assign a task or event to any active teammate (assigning work is not
// ownership of customer data); null leaves it unassigned.
async function resolveAssigneeId(req, requestedId) {
  if (!requestedId) return null;
  const member = await OrganizationMember.exists({ _id: requestedId, organizationId: req.tenant.organizationId, status: 'active' });
  if (!member) throw httpError(400, 'VALIDATION_ERROR', 'The assignee must be an active member of this organization.', [{ field: 'assigneeId', code: 'INVALID_ASSIGNEE', message: 'Pick an active team member.' }]);
  return requestedId;
}

// Owners and admins may assign any active member (or nobody); everyone else always owns
// what they create. The owner is never taken from the browser without this check.
async function resolveOwnerId(req, requestedOwnerId) {
  if (!isManager(req.member)) return req.member._id;
  if (requestedOwnerId === undefined) return req.member._id;
  if (!requestedOwnerId) return null;
  const member = await OrganizationMember.exists({ _id: requestedOwnerId, organizationId: req.tenant.organizationId, status: 'active' });
  if (!member) throw httpError(400, 'VALIDATION_ERROR', 'The owner must be an active member of this organization.', [{ field: 'ownerId', code: 'INVALID_OWNER', message: 'Pick an active team member.' }]);
  return requestedOwnerId;
}

// On update an owner change is only honoured for owners/admins.
async function ownerPatch(req, patch) {
  if (!('ownerId' in patch)) return {};
  if (!isManager(req.member)) return {};
  return { ownerId: await resolveOwnerId(req, patch.ownerId) };
}

module.exports = { visibilityFilter, privacyFilter, isOwner, resolveOwnerId, ownerPatch, assignedOrCreatedFilter, resolveAssigneeId };
