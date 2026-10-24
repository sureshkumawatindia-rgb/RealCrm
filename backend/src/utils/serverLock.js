const crypto = require('crypto');
const os = require('os');
const mongoose = require('mongoose');
const logger = require('../config/logger');

// One server at a time (F6): work that must not run twice at once when two servers start
// together (the data migrations). The lock is a document with an owner and an end time; the
// owner keeps extending it while it works, so a server that dies frees it within the lease.
const ServerLock = mongoose.models.ServerLock || mongoose.model('ServerLock', new mongoose.Schema({
  _id: { type: String },
  owner: { type: String, required: true },
  until: { type: Date, required: true },
}, { versionKey: false }));

const OWNER = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function take(name, owner, leaseMs) {
  const now = new Date();
  try {
    const lock = await ServerLock.findOneAndUpdate(
      { _id: name, until: { $lt: now } },
      { $set: { owner, until: new Date(now.getTime() + leaseMs) } },
      { upsert: true, returnDocument: 'after', lean: true },
    );
    return lock?.owner === owner;
  } catch (error) {
    if (error.code === 11000) return false; // held by another server
    throw error;
  }
}

// Runs fn while holding the lock; waits (up to waitMs) while another server holds it.
async function withServerLock(name, fn, { leaseMs = 2 * 60 * 1000, waitMs = 15 * 60 * 1000, pollMs = 2000 } = {}) {
  // Each holder has its own name, so even one server never runs the work twice at once.
  const owner = `${OWNER}:${crypto.randomBytes(3).toString('hex')}`;
  const giveUpAt = Date.now() + waitMs;
  let waited = false;
  while (!(await take(name, owner, leaseMs))) {
    if (Date.now() > giveUpAt) throw new Error(`Another server held "${name}" for too long`);
    if (!waited) logger.info(`Waiting for another server to finish "${name}"`);
    waited = true;
    await pause(pollMs);
  }
  const renew = setInterval(() => {
    ServerLock.updateOne({ _id: name, owner }, { $set: { until: new Date(Date.now() + leaseMs) } })
      .catch((error) => logger.warn(`Extending the lock "${name}" failed: ${error.message}`));
  }, Math.max(1000, Math.floor(leaseMs / 3)));
  renew.unref();
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await ServerLock.deleteOne({ _id: name, owner }).catch(() => {});
  }
}

module.exports = { withServerLock, ServerLock, OWNER };
