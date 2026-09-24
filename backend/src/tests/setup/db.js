const crypto = require('crypto');
const mongoose = require('mongoose');

// Each test file gets its own database on the shared in-memory replica set.
beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI, { dbName: `test_${crypto.randomUUID().slice(0, 8)}` });
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
