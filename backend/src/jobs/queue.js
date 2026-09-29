const crypto = require('crypto');
const os = require('os');
const Job = require('../models/Job');
const logger = require('../config/logger');

// Background jobs on MongoDB (D10). Small on purpose: define a handler, enqueue work (now, later
// or every N ms), and a worker in each server process claims due jobs one at a time with an
// atomic update. A job whose worker died is picked up again when its lock runs out. Failed
// jobs are retried with a growing pause; recurring jobs simply run again at their next time.
// The interface (define / enqueue / every / cancel / start / stop) is what the rest of the code
// uses, so another queue (Agenda, BullMQ) could replace this file later.
const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
const LOCK_MS = 10 * 60 * 1000;
const handlers = new Map();
const inFlight = new Set();
let timer = null;
let options = { pollMs: 1000, concurrency: 5 };
let ticking = false;

// Retry pause after the n-th failed attempt: 30 s, 1 min, 2 min … at most 30 min.
const backoffMs = (attempt) => Math.min(30 * 1000 * 2 ** Math.max(attempt - 1, 0), 30 * 60 * 1000);

function define(name, handler, { maxAttempts = 5 } = {}) {
  handlers.set(name, { handler, maxAttempts });
}

// uniqueKey: while a job with this key is queued or running, enqueue returns that job instead
// of adding another one.
async function enqueue(name, data = {}, { runAt = new Date(), uniqueKey, organizationId, maxAttempts, repeatEveryMs } = {}) {
  const doc = {
    name, data, runAt, organizationId, repeatEveryMs, status: 'queued', attempts: 0,
    maxAttempts: maxAttempts ?? handlers.get(name)?.maxAttempts ?? 5,
  };
  let job;
  if (uniqueKey) {
    try {
      job = await Job.findOneAndUpdate(
        { liveKey: uniqueKey },
        { $setOnInsert: { ...doc, uniqueKey, liveKey: uniqueKey } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      );
    } catch (error) {
      if (error.code !== 11000) throw error; // added by someone else at the same moment
      job = await Job.findOne({ liveKey: uniqueKey });
    }
  } else {
    job = await Job.create(doc);
  }
  kick();
  return job;
}

// A recurring job, one per key. Calling it again changes the interval of the existing job.
async function every(name, intervalMs, data = {}, { uniqueKey = name, organizationId, firstRunAt } = {}) {
  const job = await enqueue(name, data, { uniqueKey, organizationId, repeatEveryMs: intervalMs, runAt: firstRunAt || new Date() });
  if (job.repeatEveryMs !== intervalMs) await Job.updateOne({ _id: job._id }, { $set: { repeatEveryMs: intervalMs, data } });
  return job;
}

// Removes a waiting job; a running one finishes but is not repeated.
async function cancel(uniqueKey) {
  await Job.deleteMany({ liveKey: uniqueKey, status: 'queued' });
  await Job.updateMany({ liveKey: uniqueKey, status: 'running' }, { $unset: { repeatEveryMs: 1 } });
}

// Takes the next due job of a known kind (or one whose worker stopped answering).
function claim() {
  const now = new Date();
  return Job.findOneAndUpdate(
    {
      name: { $in: [...handlers.keys()] },
      $or: [{ status: 'queued', runAt: { $lte: now } }, { status: 'running', lockUntil: { $lt: now } }],
    },
    { $set: { status: 'running', lockedBy: WORKER_ID, lockUntil: new Date(now.getTime() + LOCK_MS), lastRunAt: now }, $inc: { attempts: 1 } },
    { sort: { runAt: 1 }, returnDocument: 'after' },
  );
}

async function run(job) {
  const unlock = { lockedBy: 1, lockUntil: 1 };
  const mine = { _id: job._id, lockedBy: WORKER_ID };
  try {
    await handlers.get(job.name).handler(job.data || {}, job);
    const current = await Job.findById(job._id).select('repeatEveryMs');
    if (current?.repeatEveryMs) {
      await Job.updateOne(mine, { $set: { status: 'queued', runAt: new Date(Date.now() + current.repeatEveryMs), attempts: 0, lastError: '' }, $unset: unlock });
    } else {
      await Job.updateOne(mine, { $set: { status: 'done', finishedAt: new Date(), lastError: '' }, $unset: { ...unlock, liveKey: 1 } });
    }
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    logger.warn(`Job ${job.name} (${job._id}) failed on attempt ${job.attempts}: ${message}`);
    const current = await Job.findById(job._id).select('repeatEveryMs');
    if (current?.repeatEveryMs) {
      // A recurring job is never given up; it tries again at its next time (or sooner).
      const next = Math.min(current.repeatEveryMs, backoffMs(job.attempts));
      await Job.updateOne(mine, { $set: { status: 'queued', runAt: new Date(Date.now() + next), lastError: message }, $unset: unlock });
    } else if (job.attempts < job.maxAttempts) {
      await Job.updateOne(mine, { $set: { status: 'queued', runAt: new Date(Date.now() + backoffMs(job.attempts)), lastError: message }, $unset: unlock });
    } else {
      await Job.updateOne(mine, { $set: { status: 'failed', finishedAt: new Date(), lastError: message }, $unset: { ...unlock, liveKey: 1 } });
    }
  }
}

// Starts as many due jobs as the concurrency allows.
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    while (inFlight.size < options.concurrency) {
      const job = await claim();
      if (!job) break;
      const task = run(job).finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
  } catch (error) {
    logger.error(`Job queue: ${error.message}`);
  } finally {
    ticking = false;
  }
}

// New work is picked up at once instead of at the next poll.
function kick() {
  if (timer) setImmediate(tick);
}

function start(config = {}) {
  options = { ...options, ...config };
  if (timer) return;
  timer = setInterval(tick, options.pollMs);
  timer.unref();
  kick();
}

async function stop() {
  clearInterval(timer);
  timer = null;
  await Promise.all([...inFlight]);
}

// Runs every job that is due now, and whatever they enqueue for now, until nothing is left
// (tests and scripts; the server uses start()).
async function runDue() {
  for (;;) {
    await tick();
    if (!inFlight.size) {
      const more = await Job.exists({ name: { $in: [...handlers.keys()] }, status: 'queued', runAt: { $lte: new Date() } });
      if (!more) return;
      await new Promise((resolve) => setTimeout(resolve, 5)); // another tick may be claiming it
    } else {
      await Promise.race([...inFlight]);
    }
  }
}

module.exports = { define, enqueue, every, cancel, start, stop, runDue, backoffMs, WORKER_ID };
