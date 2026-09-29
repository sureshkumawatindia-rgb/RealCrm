const LeadSourceConnection = require('../models/LeadSourceConnection');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { decrypt } = require('../utils/secretBox');
const indiamart = require('../integrations/leadSources/indiamart');
const { intake } = require('./leadIntakeService');

// IndiaMART connections: a recurring job pulls each connection's leads (never more often than
// IndiaMART allows), and the push URL takes leads IndiaMART sends on its own. Both use
// UNIQUE_QUERY_ID as the lead's sourceRef, so a lead that arrives both ways is taken once.
const JOB = 'leadsource.indiamart.poll';
// A little over IndiaMART's 5 minutes, so clocks that differ slightly never cause a 429.
const POLL_EVERY_MS = indiamart.MIN_INTERVAL_MS + 30 * 1000;
const jobKey = (connection) => `indiamart:${connection._id}`;

const apiKeyOf = (connection) => {
  if (!connection.credentialsEnc) return '';
  try {
    return JSON.parse(decrypt(connection.credentialsEnc)).apiKey || '';
  } catch {
    return '';
  }
};
const queryTypesOf = (connection) => (Array.isArray(connection.settings?.queryTypes) ? connection.settings.queryTypes : indiamart.DEFAULT_QUERY_TYPES);

// Takes one IndiaMART lead in; leads of types the organization did not choose are skipped.
async function takeLead(connection, lead) {
  const mapped = indiamart.toIntake(lead);
  if (!mapped.sourceRef) return 'rejected';
  if (!queryTypesOf(connection).includes(mapped.type)) return 'skipped';
  const result = await intake({
    organizationId: connection.organizationId,
    source: 'IndiaMART',
    sourceRef: mapped.sourceRef,
    connectionId: connection._id,
    person: mapped.person,
    enquiry: mapped.enquiry,
    raw: lead,
    receivedAt: mapped.receivedAt,
  });
  return result.outcome;
}

async function recordProblem(connection, message, { stop = false } = {}) {
  await LeadSourceConnection.updateOne(
    { _id: connection._id },
    { $set: { lastError: message, lastErrorAt: new Date(), ...(stop && { status: 'error', statusMessage: message }) } },
  );
}

/**
 * One pull. The 5-minute rule is kept with an atomic "last call" stamp, so two workers (or a
 * click on "Pull now" while the job runs) can never call IndiaMART twice within 5 minutes.
 * @returns {{ called: boolean, waitMs?, fetched?, outcomes? }}
 */
async function poll(connectionId) {
  const now = new Date();
  const connection = await LeadSourceConnection.findOneAndUpdate(
    {
      _id: connectionId, type: 'indiamart', status: 'active',
      $or: [{ lastPolledAt: null }, { lastPolledAt: { $lte: new Date(now.getTime() - indiamart.MIN_INTERVAL_MS) } }],
    },
    { $set: { lastPolledAt: now } },
    { returnDocument: 'before' },
  );
  if (!connection) {
    const current = await LeadSourceConnection.findById(connectionId).select('lastPolledAt status type');
    const waitMs = current?.lastPolledAt ? current.lastPolledAt.getTime() + indiamart.MIN_INTERVAL_MS - now.getTime() : 0;
    return { called: false, waitMs: Math.max(waitMs, 0) };
  }
  const apiKey = apiKeyOf(connection);
  if (!apiKey) return { called: false, waitMs: 0 };

  const { start, end, gap } = indiamart.pullWindow(connection.cursor?.lastEndTime, now);
  const { code, message, leads } = await indiamart.fetchLeads({ apiKey, start, end });

  if (code === 401) {
    await recordProblem(connection, 'IndiaMART refused the API key (wrong, or expired after 7 days without use). Paste a new key from IndiaMART Lead Manager.', { stop: true });
    await unschedule(connection);
    return { called: true, fetched: 0, error: 'KEY_REFUSED' };
  }
  if (code !== 200 && code !== 204) {
    const text = code === 429 ? 'IndiaMART asked us to wait 5 minutes between pulls; the next pull will catch up.' : message || `IndiaMART answered with code ${code}.`;
    await recordProblem(connection, text);
    return { called: true, fetched: 0, error: code === 429 ? 'TOO_SOON' : 'INDIAMART_ERROR' };
  }

  const outcomes = {};
  for (const lead of leads) {
    try {
      const outcome = await takeLead(connection, lead);
      outcomes[outcome] = (outcomes[outcome] || 0) + 1;
    } catch (error) {
      // One bad lead must not stop the others; the next pull (overlapping window) retries it.
      logger.error(`IndiaMART lead ${lead?.UNIQUE_QUERY_ID} for ${connection._id} failed: ${error.message}`);
      outcomes.failed = (outcomes.failed || 0) + 1;
    }
  }
  await LeadSourceConnection.updateOne(
    { _id: connection._id },
    {
      $set: {
        'cursor.lastEndTime': end, lastError: '', status: 'active',
        statusMessage: gap ? 'The CRM was not able to pull for more than 7 days; IndiaMART only gives 7 days at a time, so older leads were not fetched.' : '',
      },
    },
  );
  return { called: true, fetched: leads.length, outcomes };
}

async function schedule(connection, queue = require('../jobs/queue')) {
  if (connection.type !== 'indiamart' || connection.status !== 'active' || !connection.credentialsEnc) return;
  await queue.every(JOB, POLL_EVERY_MS, { connectionId: String(connection._id) }, { uniqueKey: jobKey(connection), organizationId: connection.organizationId });
}

async function unschedule(connection, queue = require('../jobs/queue')) {
  await queue.cancel(jobKey(connection));
}

// "Pull now" in Settings: runs at once, or says how long to wait.
async function pullNow(connection) {
  if (!connection.credentialsEnc) throw httpError(400, 'NO_API_KEY', 'Add the IndiaMART CRM API key first.');
  if (connection.status !== 'active') throw httpError(409, 'NOT_ACTIVE', 'Resume this lead source first.');
  const result = await poll(connection._id);
  if (!result.called) {
    const minutes = Math.max(1, Math.ceil(result.waitMs / 60000));
    throw httpError(429, 'TOO_SOON', `IndiaMART allows one pull every 5 minutes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
  return result;
}

// Push URL: IndiaMART sends one lead at a time. Anything but HTTP 200 makes it retry (and 48 hours
// of failures switch the push off), so leads for a paused source are answered 200 and dropped.
async function handlePush(webhookKey, payload) {
  if (!/^[a-f0-9]{32}$/.test(String(webhookKey || ''))) return { status: 404 };
  const connection = await LeadSourceConnection.findOne({ webhookKey, type: 'indiamart' });
  if (!connection) return { status: 404 };
  if (connection.status === 'paused') return { status: 200, outcome: 'paused' };
  const body = payload?.RESPONSE;
  const leads = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
  if (!leads.length) return { status: 200, outcome: 'empty' };
  const outcomes = [];
  for (const lead of leads) outcomes.push(await takeLead(connection, lead));
  return { status: 200, outcome: outcomes.join(',') };
}

// The job handler, and making sure every active connection has its job (e.g. after a restore).
function register(queue) {
  queue.define(JOB, async ({ connectionId }) => {
    const connection = await LeadSourceConnection.findById(connectionId);
    if (!connection || connection.type !== 'indiamart' || connection.status !== 'active') {
      await queue.cancel(`indiamart:${connectionId}`);
      return;
    }
    await poll(connection._id);
  }, { maxAttempts: 3 });
}

async function ensureSchedules(queue = require('../jobs/queue')) {
  const connections = await LeadSourceConnection.find({ type: 'indiamart', status: 'active', credentialsEnc: { $exists: true } });
  for (const connection of connections) await schedule(connection, queue);
}

module.exports = { JOB, POLL_EVERY_MS, poll, pullNow, schedule, unschedule, handlePush, register, ensureSchedules, apiKeyOf, queryTypesOf };
