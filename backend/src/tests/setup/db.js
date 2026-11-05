const crypto = require('crypto');
const mongoose = require('mongoose');

// Each test file gets its own database on the shared in-memory replica set. Building every model's
// indexes there takes a while when several files start at once on a slower machine, so this setup
// (and its clean-up) gets two minutes; each test keeps jest.config's 30 seconds.
const SETUP_MS = 2 * 60 * 1000;

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI, { dbName: `test_${crypto.randomUUID().slice(0, 8)}` });
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, SETUP_MS);

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}, SETUP_MS);
