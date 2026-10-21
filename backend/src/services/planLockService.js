const crypto = require('crypto');
const PlanLock = require('../models/PlanLock');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');

// Holds for plan limits (Phase 3B, D81). A limit is checked by counting, then the thing is added;
// two adds at the same moment could both count "room for one". So the count and the add happen
// while holding the company's hold for that kind of thing: the next add waits a moment and then
// counts the first one too. One document per hold; taking it is a single upsert that only
// succeeds when there is no hold or its lease has ended (a server that stopped mid-add).
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function acquire(key, { leaseMs = 15000, waitMs = 10000 } = {}) {
  const holder = crypto.randomUUID();
  const started = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    const now = new Date();
    try {
      await PlanLock.updateOne({ _id: key, expireAt: { $lte: now } }, { $set: { holder, expireAt: new Date(now.getTime() + leaseMs) } }, { upsert: true });
      return { key, holder };
    } catch (error) {
      if (error.code !== 11000) throw error; // 11000: someone holds it now
    }
    if (Date.now() - started >= waitMs) {
      throw httpError(409, 'PLAN_BUSY', 'Someone in your team is adding the same kind of thing right now. Try again in a moment.');
    }
    await sleep(Math.min(15 * 2 ** Math.min(attempt, 4), 200) * (0.5 + Math.random()));
  }
}

// Lets go of a hold, only if it is still this holder's (a lease that ended may be someone else's now).
async function release(lock) {
  if (!lock) return;
  try {
    await PlanLock.deleteOne({ _id: lock.key, holder: lock.holder });
  } catch (error) {
    logger.error(`Releasing plan hold ${lock.key} failed (it ends with its lease): ${error.message}`);
  }
}

module.exports = { acquire, release };
