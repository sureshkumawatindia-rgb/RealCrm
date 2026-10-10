const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Invite = require('../models/Invite');
const bus = require('../realtime/bus');
const { audit } = require('../utils/audit');
const phoneVisibility = require('./phoneVisibility');

// Company-wide choices for the team (Settings → Team & Access) and the first steps after
// sign-up.

const serializeSettings = (organization) => ({
  hidePhonesFromAgents: organization?.settings?.hidePhonesFromAgents !== false, // D65: on unless turned off
});

// GET /organization/settings — every member (the pages show what applies to them).
async function getSettings(req) {
  return serializeSettings(await Organization.findById(req.tenant.organizationId).select('settings').lean());
}

// PATCH /organization/settings — owners and admins.
async function updateSettings(req, patch) {
  const { organizationId } = req.tenant;
  const before = await getSettings(req);
  const changes = {};
  if (typeof patch.hidePhonesFromAgents === 'boolean' && patch.hidePhonesFromAgents !== before.hidePhonesFromAgents) {
    changes.hidePhonesFromAgents = patch.hidePhonesFromAgents;
  }
  if (!Object.keys(changes).length) return before;
  await Organization.updateOne(
    { _id: organizationId },
    { $set: Object.fromEntries(Object.entries(changes).map(([key, value]) => [`settings.${key}`, value])) },
  );
  phoneVisibility.forget(organizationId);
  // Open pages pick it up: their live connection is told, and lists reload.
  bus.emit('privacy:phones-changed', { organizationId, hidePhonesFromAgents: changes.hidePhonesFromAgents ?? before.hidePhonesFromAgents });
  await audit(req, { action: 'organization.settings_updated', entityType: 'Organization', entityId: organizationId, changes });
  return { ...before, ...changes };
}

// GET /organization/onboarding — owners and admins: whether "Invite your team" still comes after
// sign-in (D64). A company that already has teammates or invites never sees it.
async function onboarding(req) {
  const { organizationId } = req.tenant;
  const organization = await Organization.findById(organizationId).select('onboarding').lean();
  if (organization?.onboarding?.teamStepAt) return { teamStep: false };
  const [members, invites] = await Promise.all([
    OrganizationMember.countDocuments({ organizationId, status: 'active' }),
    Invite.countDocuments({ organizationId }),
  ]);
  return { teamStep: members <= 1 && invites === 0 };
}

// POST /organization/onboarding/team { skipped } — the step was done or skipped; it never comes
// back (Settings → Team & Access is always there).
async function finishTeamStep(req, { skipped = false } = {}) {
  const { organizationId } = req.tenant;
  const result = await Organization.updateOne(
    { _id: organizationId, 'onboarding.teamStepAt': null },
    { $set: { 'onboarding.teamStepAt': new Date() } },
  );
  if (result.modifiedCount) {
    await audit(req, { action: skipped ? 'onboarding.team_skipped' : 'onboarding.team_done', entityType: 'Organization', entityId: organizationId });
  }
  return { teamStep: false };
}

module.exports = { getSettings, updateSettings, onboarding, finishTeamStep, serializeSettings };
