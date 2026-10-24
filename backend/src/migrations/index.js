const Migration = require('../models/Migration');
const logger = require('../config/logger');
const { withServerLock } = require('../utils/serverLock');

// Data migrations run once each, in this order, when the server starts.
// Every migration must be idempotent: safe to run again if the server stops halfway.
const MIGRATIONS = [
  require('./001-organization-field-names'),
  require('./002-quotations-v2'),
  require('./003-workflows-v2'),
  require('./004-sequences-v2'),
  require('./005-subscriptions'),
  require('./006-organization-slugs'),
  require('./007-lead-pipelines'),
];

// Two servers starting together (F6): one runs them, the other waits and then finds them done.
function runMigrations() {
  return withServerLock('migrations', applyAll);
}

async function applyAll() {
  for (const migration of MIGRATIONS) {
    if (await Migration.exists({ name: migration.name })) continue;
    const result = await migration.up();
    await Migration.create({ name: migration.name, appliedAt: new Date() });
    logger.info(`Migration applied: ${migration.name} ${JSON.stringify(result || {})}`);
  }
}

module.exports = { runMigrations, MIGRATIONS };
