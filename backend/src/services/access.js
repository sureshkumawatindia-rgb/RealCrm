const OrganizationMember = require('../models/OrganizationMember');
const httpError = require('../utils/httpError');
const { isManager, canViewAll } = require('../constants/permissions');

const asList = (modules) => (Array.isArray(modules) ? modules : [modules]);

// Record scope (D17): agents and viewers see only records they own, unless they have
// "<module>:view_all" for one of the modules.
function visibilityFilter(req, modules, ownerField = 'ownerId') {
  if (asList(modules).some((module) => canViewAll(req.member, module))) return {};
  return { [ownerField]: req.member._id };
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

module.exports = { visibilityFilter, resolveOwnerId, ownerPatch };
