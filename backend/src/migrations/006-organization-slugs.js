const Organization = require('../models/Organization');
const { codeFromName, uniqueCode } = require('../utils/workspaceCode');

// Every organization gets a workspace code for the login page (D66), made from its name; the
// oldest company keeps the plain code ("sharma-traders"), a later one with the same name gets
// "sharma-traders-2". Idempotent: only organizations without a code are touched, and a code is
// written only while the organization still has none.
async function up() {
  const organizations = await Organization.collection
    .find({ slug: { $not: { $type: 'string' } } }, { projection: { name: 1 } })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();

  let updated = 0;
  for (const organization of organizations) {
    for (let attempt = 1; ; attempt += 1) {
      const slug = await uniqueCode(Organization, codeFromName(organization.name));
      try {
        const result = await Organization.collection.updateOne({ _id: organization._id, slug: { $not: { $type: 'string' } } }, { $set: { slug } });
        updated += result.modifiedCount;
        break;
      } catch (error) {
        // A company signed up with the same code a moment ago: take the next one.
        if (error.code !== 11000 || attempt === 5) throw error;
      }
    }
  }
  return { updated };
}

module.exports = { name: '006-organization-slugs', up };
