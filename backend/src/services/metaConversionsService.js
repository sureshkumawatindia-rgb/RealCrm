const ConversionsApiConnection = require('../models/ConversionsApiConnection');
const Organization = require('../models/Organization');
const Lead = require('../models/Lead');
const bus = require('../realtime/bus');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { encrypt, decrypt } = require('../utils/secretBox');
const { LEAD_STAGES } = require('../constants/crm');
const meta = require('../integrations/meta/conversions');
const planService = require('./planService');

// Meta Conversions API for CRM (Phase 10C, Pro plan and up): when a lead is created or moves to
// another stage, the stage goes to the company's Meta dataset as a "conversion leads" event,
// so Meta learns which Lead Ads leads become customers. Lead Ads leads carry Meta's lead id;
// with "all sources" other leads go too, matched by hashed phone and email. Sent by a job (one
// per event, never twice); events older than 7 days are not sent (Meta refuses them).
const JOB = 'capi.send';

function serialize(connection, organization) {
  return {
    available: planService.hasFeature(organization, 'conversionsApi'),
    connected: Boolean(connection),
    ...(connection && {
      datasetId: connection.datasetId,
      datasetName: connection.datasetName,
      accessToken: { last4: connection.accessTokenLast4 },
      testEventCode: connection.testEventCode,
      enabled: connection.enabled,
      allSources: connection.allSources,
      stages: connection.stages.length ? connection.stages : LEAD_STAGES,
      status: connection.status,
      statusMessage: connection.statusMessage,
      checkedAt: connection.checkedAt || null,
      stats: { sent: connection.stats?.sent || 0, failed: connection.stats?.failed || 0, skipped: connection.stats?.skipped || 0, lastSentAt: connection.stats?.lastSentAt || null, lastError: connection.stats?.lastError || '', lastErrorAt: connection.stats?.lastErrorAt || null },
    }),
    stagesAvailable: LEAD_STAGES,
  };
}

async function get(req) {
  const [connection, organization] = await Promise.all([
    ConversionsApiConnection.findOne({ organizationId: req.tenant.organizationId }),
    Organization.findById(req.tenant.organizationId),
  ]);
  return serialize(connection, organization);
}

// PUT /meta-conversions { datasetId, accessToken?, testEventCode?, enabled?, allSources?, stages? }
async function save(req, body) {
  await planService.assertFeature(req.tenant.organizationId, 'conversionsApi');
  const organizationId = req.tenant.organizationId;
  let connection = await ConversionsApiConnection.findOne({ organizationId });
  if (!connection && !body.accessToken) throw httpError(400, 'VALIDATION_ERROR', 'Paste the access token from Meta Events Manager.', [{ field: 'accessToken', message: 'Paste the access token.' }]);
  const datasetId = body.datasetId || connection?.datasetId;
  const accessToken = body.accessToken || decrypt(connection.accessTokenEnc);
  // A new dataset or token is checked with Meta first.
  if (!connection || body.accessToken || body.datasetId !== connection.datasetId) {
    const dataset = await meta.checkDataset({ datasetId, accessToken });
    if (!connection) connection = new ConversionsApiConnection({ organizationId, createdById: req.user._id, datasetId, accessTokenEnc: encrypt(accessToken) });
    Object.assign(connection, {
      datasetId, datasetName: dataset.name, accessTokenEnc: encrypt(accessToken), accessTokenLast4: accessToken.slice(-4),
      status: 'connected', statusMessage: '', checkedAt: new Date(),
    });
  }
  for (const key of ['testEventCode', 'enabled', 'allSources', 'stages']) if (body[key] !== undefined) connection[key] = body[key];
  await connection.save();
  await audit(req, { action: 'capi.saved', entityType: 'ConversionsApiConnection', entityId: connection._id, changes: { datasetId, enabled: connection.enabled, allSources: connection.allSources, stages: connection.stages } });
  return get(req);
}

async function remove(req) {
  await ConversionsApiConnection.deleteOne({ organizationId: req.tenant.organizationId });
  await audit(req, { action: 'capi.removed', entityType: 'ConversionsApiConnection' });
}

const credentialsOf = (connection) => ({ datasetId: connection.datasetId, accessToken: decrypt(connection.accessTokenEnc), testEventCode: connection.testEventCode || undefined });

// POST /meta-conversions/test — a sample event to Meta's Test events (needs the test code).
async function test(req) {
  const connection = await ConversionsApiConnection.findOne({ organizationId: req.tenant.organizationId });
  if (!connection) throw httpError(409, 'NOT_CONNECTED', 'Connect the Conversions API first.');
  if (!connection.testEventCode) throw httpError(400, 'VALIDATION_ERROR', 'Enter the test event code from Meta Events Manager → Test events first.', [{ field: 'testEventCode', message: 'Enter the test event code.' }]);
  const event = meta.eventOf({ stage: 'New', at: new Date(), email: 'test@example.com', phoneE164: '+919000000000' });
  const result = await meta.sendEvents(credentialsOf(connection), [event]);
  return { ...result, message: `Meta received ${result.eventsReceived} test event. See it in Events Manager → Test events.` };
}

async function bump(connectionId, outcome, error = '') {
  const update = outcome === 'sent'
    ? { $inc: { 'stats.sent': 1 }, $set: { 'stats.lastSentAt': new Date() } }
    : outcome === 'failed'
      ? { $inc: { 'stats.failed': 1 }, $set: { 'stats.lastError': String(error).slice(0, 300), 'stats.lastErrorAt': new Date() } }
      : { $inc: { 'stats.skipped': 1 } };
  await ConversionsApiConnection.updateOne({ _id: connectionId }, update);
}

// The job: one lead event → one Meta event (or skipped: another source, a stage not chosen,
// nothing to match by, too old).
async function send({ event }) {
  const connection = await ConversionsApiConnection.findOne({ organizationId: event.organizationId, enabled: true });
  if (!connection) return 'off';
  if (!planService.hasFeature(await Organization.findById(event.organizationId), 'conversionsApi')) return 'plan';
  const lead = await Lead.findOne({ _id: event.leadId, organizationId: event.organizationId }).populate({ path: 'contactId', select: 'email phoneE164' });
  if (!lead) return 'gone';
  const stage = event.type === 'lead.stage_changed' ? event.to : lead.stage;
  const stages = connection.stages.length ? connection.stages : LEAD_STAGES;
  const fromLeadAds = lead.source === 'Facebook';
  if (!stages.includes(stage) || (!fromLeadAds && !connection.allSources)) {
    await bump(connection._id, 'skipped');
    return 'skipped';
  }
  const metaEvent = meta.eventOf({
    stage, at: event.at, leadgenId: fromLeadAds ? lead.sourceRef : null, email: lead.contactId?.email, phoneE164: lead.contactId?.phoneE164,
  });
  if (!metaEvent) {
    await bump(connection._id, 'skipped');
    return 'skipped';
  }
  try {
    await meta.sendEvents(credentialsOf(connection), [metaEvent]);
    await bump(connection._id, 'sent');
    return 'sent';
  } catch (error) {
    await bump(connection._id, 'failed', error.message);
    if (error.statusCode >= 500) throw error; // Meta was not reached: the job tries again
    logger.warn(`Conversions API event for lead ${lead._id} refused: ${error.message}`);
    return 'failed';
  }
}

let listener = null;
function register(queue) {
  queue.define(JOB, send, { maxAttempts: 4 });
  if (listener) bus.off('automation:event', listener);
  listener = (event) => {
    if (!['lead.created', 'lead.stage_changed'].includes(event.type)) return;
    ConversionsApiConnection.exists({ organizationId: event.organizationId, enabled: true })
      .then((any) => any && queue.enqueue(JOB, { event }, { uniqueKey: `capi:${event.key || `${event.type}:${event.leadId}:${event.to || ''}:${Date.now()}`}`, organizationId: event.organizationId }))
      .catch((error) => logger.error(`Conversions API event could not be queued: ${error.message}`));
  };
  bus.on('automation:event', listener);
}

module.exports = { JOB, get, save, remove, test, send, register };
