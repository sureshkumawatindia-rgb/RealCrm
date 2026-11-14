const InboundEvent = require('../models/InboundEvent');
const Job = require('../models/Job');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');

// The platform admin page → Health (Phase 9, D151): what arrived from outside and could not be
// processed (webhooks from Meta and the gateways), and background jobs that gave up, with "try
// again". Counts, kinds and error words only: numbers and emails are taken out of the errors,
// as this page never shows a company's customers.
const LIST = 200;
const scrub = (text) => String(text || '').replace(/[^\s@]+@[^\s@]+/g, '•••').replace(/\+?\d[\d\s-]{6,}\d/g, '•••').slice(0, 200);

function groupBy(rows, keyOf, at) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) || { key, count: 0, latestAt: null, error: '' };
    group.count += 1;
    if (!group.latestAt || row[at] > group.latestAt) {
      group.latestAt = row[at];
      group.error = scrub(row.error ?? row.lastError);
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.latestAt - a.latestAt);
}

async function problems() {
  const [events, eventCount, jobs, jobCount] = await Promise.all([
    InboundEvent.find({ status: 'failed' }).sort({ updatedAt: -1 }).limit(LIST).select('provider kind attempts error updatedAt').lean(),
    InboundEvent.countDocuments({ status: 'failed' }),
    Job.find({ status: 'failed' }).sort({ finishedAt: -1 }).limit(LIST).select('name attempts lastError finishedAt').lean(),
    Job.countDocuments({ status: 'failed' }),
  ]);
  return {
    inbound: {
      total: eventCount,
      groups: groupBy(events, (e) => `${e.provider} · ${e.kind}`, 'updatedAt').map(({ key, ...rest }) => ({ ...rest, provider: key.split(' · ')[0], kind: key.split(' · ')[1] })),
    },
    jobs: {
      total: jobCount,
      groups: groupBy(jobs, (j) => j.name, 'finishedAt').map(({ key, ...rest }) => ({ ...rest, name: key })),
      latest: jobs.slice(0, 20).map((j) => ({ id: String(j._id), name: j.name, attempts: j.attempts, at: j.finishedAt, error: scrub(j.lastError) })),
    },
  };
}

// POST /platform/health/inbound/retry — every webhook that could not be processed, once more.
async function retryInbound(req, queue = require('../jobs/queue')) { // eslint-disable-line global-require
  const events = await InboundEvent.find({ status: 'failed' }).limit(1000).select('provider');
  const chatEvents = events.filter((e) => ['whatsapp', 'meta-social'].includes(e.provider)).map((e) => e._id);
  const others = events.filter((e) => !['whatsapp', 'meta-social'].includes(e.provider));
  await InboundEvent.updateMany({ _id: { $in: events.map((e) => e._id) } }, { $set: { status: 'received', attempts: 0, error: '' } });
  // WhatsApp's own processing, or the job each gateway's webhook goes through.
  require('./whatsappInboundService').processLater(chatEvents); // eslint-disable-line global-require
  for (const event of others) {
    const job = event.provider.endsWith('-billing') ? 'billing.webhook' : 'payment.webhook';
    await queue.enqueue(job, { eventId: String(event._id) }, { uniqueKey: `${job}:retry:${event._id}`, maxAttempts: 3 });
  }
  await audit(req, { action: 'platform.webhooks_retried', entityType: 'InboundEvent', changes: { count: events.length } });
  return { retried: events.length };
}

// POST /platform/health/jobs/:id/retry — a job that gave up, once more.
async function retryJob(req, id) {
  const { modifiedCount } = await Job.updateOne(
    { _id: id, status: 'failed' },
    { $set: { status: 'queued', runAt: new Date(), attempts: 0, lastError: '' }, $unset: { finishedAt: 1 } },
  );
  if (!modifiedCount) throw httpError(404, 'NOT_FOUND', 'That job is not waiting to be tried again.');
  await audit(req, { action: 'platform.job_retried', entityType: 'Job', entityId: id });
  return { retried: 1 };
}

module.exports = { problems, retryInbound, retryJob };
