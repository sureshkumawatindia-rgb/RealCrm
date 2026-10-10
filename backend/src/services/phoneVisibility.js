const Organization = require('../models/Organization');
const { isManager } = require('../constants/permissions');

// Whether a member sees customers' phone numbers masked (D65): agents and viewers do while their
// company's "Hide customer phone numbers from agents" is on (the default); owners and admins
// never. The setting is read at most every 30 seconds per company (every API request asks).
const TTL_MS = 30 * 1000;
const cache = new Map();

async function companyHidesPhones(organizationId) {
  const key = String(organizationId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const organization = await Organization.findById(organizationId).select('settings.hidePhonesFromAgents').lean();
  const value = organization?.settings?.hidePhonesFromAgents !== false; // on unless an owner or admin turned it off
  cache.set(key, { value, at: Date.now() });
  return value;
}

async function hidesPhonesFor(member) {
  if (!member || isManager(member)) return false;
  return companyHidesPhones(member.organizationId);
}

// After the setting changes: the next request reads it again.
function forget(organizationId) {
  cache.delete(String(organizationId));
}

module.exports = { hidesPhonesFor, companyHidesPhones, forget };
