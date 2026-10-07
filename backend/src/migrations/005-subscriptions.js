const Organization = require('../models/Organization');

// Organizations from before billing (Phase 10) are comped: they keep their plan without a trial
// or an end date, so a CRM in use never locks (D48). New organizations start a trial at sign-up.
// Idempotent: only organizations without a subscription status are touched.
async function up() {
  const result = await Organization.collection.updateMany(
    { 'subscription.status': { $exists: false } },
    { $set: { 'subscription.status': 'comped', 'subscription.since': new Date() } },
  );
  return { updated: result.modifiedCount };
}

module.exports = { name: '005-subscriptions', up };
