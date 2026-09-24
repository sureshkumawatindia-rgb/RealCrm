const Organization = require('../models/Organization');
const { normalizeGstin, stateCodeFromGstin } = require('../utils/gstin');

// Company profile fields were saved as gst / pincode / founded. They become
// gstin / postalCode / foundedYear (decision D14), and stateCode is derived from the GSTIN.
// Idempotent: documents without the old fields are skipped.
async function up() {
  const organizations = await Organization.collection
    .find({ $or: [{ gst: { $exists: true } }, { pincode: { $exists: true } }, { founded: { $exists: true } }] })
    .toArray();

  for (const organization of organizations) {
    const set = {};
    const unset = {};

    if ('gst' in organization) {
      if (!organization.gstin && organization.gst) set.gstin = normalizeGstin(organization.gst);
      unset.gst = '';
    }
    if ('pincode' in organization) {
      if (!organization.postalCode && organization.pincode) set.postalCode = String(organization.pincode).trim();
      unset.pincode = '';
    }
    if ('founded' in organization) {
      const year = Number.parseInt(organization.founded, 10);
      if (!organization.foundedYear && year >= 1800 && year <= 2100) set.foundedYear = year;
      // A value that is not a year stays in "founded" instead of being lost.
      if (!organization.founded || set.foundedYear || organization.foundedYear) unset.founded = '';
    }
    const stateCode = stateCodeFromGstin(set.gstin || organization.gstin);
    if (stateCode && !organization.stateCode) set.stateCode = stateCode;

    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    if (Object.keys(update).length) await Organization.collection.updateOne({ _id: organization._id }, update);
  }
  return { updated: organizations.length };
}

module.exports = { name: '001-organization-field-names', up };
