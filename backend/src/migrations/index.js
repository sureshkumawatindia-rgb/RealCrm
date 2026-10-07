const Migration = require('../models/Migration');
const logger = require('../config/logger');

// Data migrations run once each, in this order, when the server starts.
// Every migration must be idempotent: safe to run again if the server stops halfway.
const MIGRATIONS = [
  require('./001-organization-field-names'),
  require('./002-quotations-v2'),
  require('./003-workflows-v2'),
  require('./004-sequences-v2'),
  require('./005-subscriptions'),
];

async function runMigrations() {
  for (const migration of MIGRATIONS) {
    if (await Migration.exists({ name: migration.name })) continue;
    const result = await migration.up();
    await Migration.create({ name: migration.name, appliedAt: new Date() });
    logger.info(`Migration applied: ${migration.name} ${JSON.stringify(result || {})}`);
  }
}

module.exports = { runMigrations, MIGRATIONS };
