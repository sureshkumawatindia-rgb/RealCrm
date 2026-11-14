const Message = require('../models/Message');
const logger = require('../config/logger');
const bus = require('../realtime/bus');

// A chat message that could not go because of something that may pass — Meta in trouble, too many
// at once (Phase 9, D151; docs/RELIABILITY.md) — stays "queued" and is tried again by itself:
// after 1, 5, 15, 30 minutes, 1, 2 and 4 hours (about 8 hours in all), then it fails, and the person
// who wrote it is told. A refusal that will not pass (a wrong number, the template) fails at once.
// In rare cases Meta took a message but its answer was lost: the customer may get it twice.
// The sending itself is in services/conversationService.js (resendStored).

const JOBS = { RETRY: 'message.retry', SWEEP: 'message.sweep' };
const MINUTE = 60 * 1000;
const DELAYS_MIN = [1, 5, 15, 30, 60, 120, 240];
const STUCK_MS = 10 * MINUTE; // "queued" with no next try for this long: its server stopped half-way
const OVERDUE_MS = 15 * MINUTE; // a next try this late: its job was lost
const SWEEP_EVERY_MS = 5 * MINUTE;
const SWEEP_SIZE = 200;

// When the next try goes after this many tries; null when they are over.
const nextTryAt = (attempts, now = new Date()) => (attempts <= DELAYS_MIN.length ? new Date(now.getTime() + DELAYS_MIN[attempts - 1] * MINUTE) : null);

// A try failed: on the message, waiting for the next one or failed for good. body: what was to go
// (kept for the next try and for "Try again"). → true when it will be tried again.
function afterFailedTry(message, error, body = null, now = new Date()) {
  const attempts = (message.retry?.attempts || 0) + 1;
  const nextAt = error?.temporary ? nextTryAt(attempts, now) : null;
  const reason = String(error?.message || 'Sending failed').slice(0, 500);
  const keep = body || message.retry?.body;
  message.set('retry', { attempts, lastError: reason, ...(nextAt && { nextAt }), ...(keep && { body: keep }) });
  if (nextAt) {
    message.status = 'queued';
    message.set('failedAt', undefined);
    message.set('error', undefined);
  } else {
    message.status = 'failed';
    message.failedAt = now;
    message.error = { code: Number(error?.providerCode) || undefined, message: reason };
  }
  return Boolean(nextAt);
}

function failForGood(message, reason, now = new Date()) {
  const keep = message.retry?.body;
  message.status = 'failed';
  message.failedAt = now;
  message.error = { message: String(reason).slice(0, 500) };
  message.set('retry', { attempts: message.retry?.attempts || 1, lastError: String(reason).slice(0, 500), ...(keep && { body: keep }) });
}

const enqueue = (message, queue = require('../jobs/queue')) => queue.enqueue(JOBS.RETRY, { id: String(message._id), attempts: message.retry.attempts }, { // eslint-disable-line global-require
  runAt: message.retry.nextAt, uniqueKey: `${JOBS.RETRY}:${message._id}:${message.retry.attempts}`, organizationId: message.organizationId, maxAttempts: 2,
});

// The job: this try, once, if the message is still waiting for it.
async function run({ id, attempts }) {
  const message = await Message.findOne({ _id: id, status: 'queued', 'retry.attempts': attempts });
  if (!message) return 'stale';
  await require('./conversationService').resendStored(message); // eslint-disable-line global-require
  return message.status;
}

// Every few minutes: a message left half-way when a server stopped is said to have failed; a
// next try whose job was lost is asked for again.
async function sweep(now = new Date(), queue = require('../jobs/queue')) { // eslint-disable-line global-require
  const stuck = await Message.find({ status: 'queued', direction: 'out', createdAt: { $lt: new Date(now.getTime() - STUCK_MS) }, 'retry.nextAt': null }).limit(SWEEP_SIZE);
  for (const message of stuck) {
    failForGood(message, 'The server restarted while sending this.', now);
    await message.save();
    bus.emit('message:status', { organizationId: message.organizationId, message });
  }
  const late = await Message.find({ status: 'queued', direction: 'out', 'retry.nextAt': { $lt: new Date(now.getTime() - OVERDUE_MS) } }).limit(SWEEP_SIZE);
  for (const message of late) {
    message.set('retry.nextAt', now);
    await message.save();
    await enqueue(message, queue);
  }
  if (stuck.length || late.length) logger.info(`Message sweep: ${stuck.length} stuck, ${late.length} overdue`);
  return { stuck: stuck.length, late: late.length };
}

function register(queue) {
  queue.define(JOBS.RETRY, run, { maxAttempts: 2 });
  queue.define(JOBS.SWEEP, () => sweep(new Date(), queue), { maxAttempts: 1 });
  queue.every(JOBS.SWEEP, SWEEP_EVERY_MS).catch((error) => logger.error(`Scheduling ${JOBS.SWEEP} failed: ${error.message}`));
}

module.exports = { JOBS, DELAYS_MIN, nextTryAt, afterFailedTry, failForGood, enqueue, run, sweep, register };
