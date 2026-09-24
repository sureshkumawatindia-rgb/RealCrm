const Counter = require('../models/Counter');

// Atomically returns the next number of a per-organization sequence.
// start: the first number handed out (e.g. 1000 for tickets).
async function nextSequence(organizationId, name, { start = 1, session } = {}) {
  const counter = await Counter.findOneAndUpdate(
    { organizationId, name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, session },
  );
  return start - 1 + counter.seq;
}

module.exports = { nextSequence };
