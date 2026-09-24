const { MongoMemoryReplSet } = require('mongodb-memory-server');

// One in-memory single-node replica set for the whole run (replica set = transactions work).
// Tests never touch the real database in backend/.env.
module.exports = async function globalSetup() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  globalThis.__MONGO_REPLSET__ = replSet;
  process.env.MONGO_TEST_URI = replSet.getUri();
};
