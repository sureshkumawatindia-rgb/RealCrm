const UsageCounter = require('../models/UsageCounter');
const logger = require('../config/logger');
const { indiaDate } = require('../utils/dates');

// Counts kept as they happen (Phase 3A, D80), for what leaves no record of its own: the public
// API's calls. One atomic $inc per call, so calls at the same moment are all counted. Counting
// never fails the call it counts.
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 430; // the month plus 400 days

const monthKey = (now = new Date()) => indiaDate(0, now).slice(0, 7);

async function bump(organizationId, metric, by = 1, now = new Date()) {
  const filter = { organizationId, metric, period: monthKey(now) };
  const update = { $inc: { count: by }, $setOnInsert: { expireAt: new Date(now.getTime() + KEEP_DAYS * DAY_MS) } };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await UsageCounter.updateOne(filter, update, { upsert: true });
      return;
    } catch (error) {
      // Two first calls of a month can race to make the row; the second one then just adds.
      if (error.code === 11000 && attempt === 1) continue;
      logger.error(`Usage count ${metric} for ${organizationId} failed: ${error.message}`);
      return;
    }
  }
}

async function get(organizationId, metric, now = new Date()) {
  const row = await UsageCounter.findOne({ organizationId, metric, period: monthKey(now) }).select('count').lean();
  return row?.count || 0;
}

module.exports = { bump, get, monthKey };
