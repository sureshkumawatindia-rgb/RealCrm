const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const UsageSnapshot = require('../models/UsageSnapshot');
const WebhookDelivery = require('../models/WebhookDelivery');
const AutomationRun = require('../models/AutomationRun');
const Document = require('../models/Document');
const CustomFieldDefinition = require('../models/CustomFieldDefinition');
const CustomObjectDefinition = require('../models/CustomObjectDefinition');
const logger = require('../config/logger');
const { indiaDate } = require('../utils/dates');
const planService = require('./planService');
const aiService = require('./aiService');
const usageCounter = require('./usageCounterService');
const { notify } = require('./notificationService');
const { LIMITS, METERS, ALERT_LEVELS } = require('../constants/plans');

// Usage meters (Phase 3A, D80): everything a company uses on one screen, how it went over the
// last days, and a bell note to its owners and admins before a limit stops them.
//   metersOf   — the plan's limits (with extras), the AI budget, and what is counted with no limit
//   history    — GET /billing/usage/history, from the daily snapshots
//   run        — the hourly job: today's snapshot (once a day) and the 80% / 100% alerts
// Counted from the records like the limits (planService), except API calls (usageCounterService).
const JOB = 'billing.usage';
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 400;
const PLAN_LINK = 'Settings.html?tab=plan';
const AI_METRIC = 'aiBudget';
const AI_LABEL = 'AI assistant budget this month';
const ORDER = [...Object.keys(LIMITS), AI_METRIC, ...Object.keys(METERS)];

const objectId = (id) => new mongoose.Types.ObjectId(String(id));
const number = (value) => Number(value).toLocaleString('en-IN');

// --- counting ---------------------------------------------------------------------------------------
const COUNTED = {
  apiCallsPerMonth: (organizationId) => usageCounter.get(organizationId, 'apiCalls'),
  // Deliveries are kept 30 days (their TTL), so on a 31st the 1st's may be gone already.
  webhookSendsPerMonth: (organizationId) => WebhookDelivery.countDocuments({ organizationId, createdAt: { $gte: planService.monthStart() } }),
  workflowRunsPerMonth: (organizationId) => AutomationRun.countDocuments({ organizationId, createdAt: { $gte: planService.monthStart() } }),
  fileBytes: async (organizationId) => {
    const [row] = await Document.aggregate([
      { $match: { organizationId: objectId(organizationId), deletedAt: null } },
      { $group: { _id: null, bytes: { $sum: '$sizeBytes' } } },
    ]);
    return row?.bytes || 0;
  },
  customFields: (organizationId) => CustomFieldDefinition.countDocuments({ organizationId, status: 'active' }),
  customObjects: (organizationId) => CustomObjectDefinition.countDocuments({ organizationId, status: 'active' }),
};

// The AI assistant's budget as a meter (micro-dollars): only where the platform has set up AI.
async function aiMeter(organization) {
  if (!aiService.configured()) return null;
  const limit = aiService.budgetMicros(organization);
  if (!(limit > 0)) return null;
  const used = (await aiService.spentThisMonth(organization._id)).costMicros;
  return { metric: AI_METRIC, label: AI_LABEL, used, limit, left: Math.max(limit - used, 0), monthly: true, unit: 'budget', group: 'limit', extra: 0, until: null };
}

// counted: false leaves out the meters with no limit (the hourly alert check does not need them).
async function metersOf(organization, { counted = true } = {}) {
  const plan = planService.effectivePlanOf(organization);
  const extras = planService.extrasOf(organization);
  const [limited, ai, others] = await Promise.all([
    planService.usageOf(organization._id, plan),
    aiMeter(organization),
    counted ? Promise.all(Object.keys(METERS).map((metric) => COUNTED[metric](organization._id))) : [],
  ]);
  return [
    ...limited.map((meter) => ({
      ...meter,
      unit: 'count',
      group: 'limit',
      extra: extras[meter.metric]?.extra || 0,
      until: extras[meter.metric] && !extras[meter.metric].forGood ? extras[meter.metric].until : null,
    })),
    ...(ai ? [ai] : []),
    ...(counted ? Object.entries(METERS).map(([metric, { label, unit, monthly }], index) => ({
      metric, label, used: others[index], limit: null, left: null, monthly: Boolean(monthly), unit, group: 'counted', extra: 0, until: null,
    })) : []),
  ];
}

// --- history ----------------------------------------------------------------------------------------
const labelOf = (metric) => (metric === AI_METRIC ? AI_LABEL : LIMITS[metric]?.label || METERS[metric]?.label || metric);
const unitOf = (metric) => (metric === AI_METRIC ? 'budget' : METERS[metric]?.unit || 'count');

// GET /billing/usage/history?days=30 (owners and admins): one point a day per meter, oldest first.
async function history(req, { days = 30 } = {}) {
  const to = indiaDate(0);
  const from = indiaDate(-(days - 1));
  const snapshots = await UsageSnapshot.find({ organizationId: req.tenant.organizationId, day: { $gte: from, $lte: to } }).sort({ day: 1 }).lean();
  const seen = new Set(snapshots.flatMap((snapshot) => snapshot.meters.map((meter) => meter.metric)));
  return {
    from,
    to,
    meters: ORDER.filter((metric) => seen.has(metric)).map((metric) => ({
      metric,
      label: labelOf(metric),
      unit: unitOf(metric),
      points: snapshots.flatMap((snapshot) => {
        const meter = snapshot.meters.find((m) => m.metric === metric);
        return meter ? [{ day: snapshot.day, used: meter.used, limit: meter.limit ?? null }] : [];
      }),
    })),
  };
}

// --- the hourly job ---------------------------------------------------------------------------------
// Today's snapshot, once: the day is claimed first, so two workers (or a retry) never write it twice.
async function snapshot(organization, meters, { day, now }) {
  const claimed = await Organization.findOneAndUpdate({ _id: organization._id, usageSnapshotOn: { $ne: day } }, { $set: { usageSnapshotOn: day } });
  if (!claimed) return false;
  await UsageSnapshot.updateOne(
    { organizationId: organization._id, day },
    { $setOnInsert: { plan: organization.plan || '', meters: meters.map(({ metric, used, limit }) => ({ metric, used, limit: limit ?? null })), expireAt: new Date(now.getTime() + KEEP_DAYS * DAY_MS) } },
    { upsert: true },
  );
  return true;
}

function levelOf(meter) {
  if (!(meter.limit > 0)) return 0;
  return ALERT_LEVELS.slice().reverse().find((level) => meter.used * 100 >= meter.limit * level) || 0;
}

const nextMonthText = (now) => {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

// The bell note for a meter at a level (English, like the other billing notes).
function noteFor(meter, level, planName, now) {
  const again = nextMonthText(now);
  if (meter.metric === AI_METRIC) {
    return level >= 100
      ? { title: "AI assistant: this month's budget is used up", body: `Suggestions and auto-replies are paused until ${again}.` }
      : { title: `AI assistant: ${level}% of this month's budget used`, body: `The assistant pauses when the budget is used up and is back on ${again}.` };
  }
  const { label, noun } = LIMITS[meter.metric];
  const counts = `${number(meter.used)} of ${number(meter.limit)} ${noun} on the ${planName} plan${meter.extra ? ` (with its extra)` : ''}.`;
  if (level < 100) {
    return { title: `${label}: ${level}% of your plan used`, body: `${counts} See Settings → Plan & usage to upgrade${meter.monthly ? `; the count starts again on ${again}` : ''}.` };
  }
  if (meter.monthly) {
    return { title: `${label}: your plan's limit is reached`, body: `${counts} More start again on ${again}, or upgrade in Settings → Plan & usage.` };
  }
  const stillComing = meter.metric === 'contacts' ? ' New customers who write on WhatsApp and leads from your lead sources still come in.' : '';
  return { title: `${label}: your plan's limit is reached`, body: `${counts} Adding more stops until you upgrade in Settings → Plan & usage.${stillComing}` };
}

const managersOf = async (organizationId) => (await OrganizationMember.find({ organizationId, status: 'active', role: { $in: ['owner', 'admin'] } }).select('_id')).map((m) => m._id);

// Tells the owners and admins once per level per period: a month for monthly meters, otherwise
// until the meter falls below the first level again. Each level is claimed before it is sent.
async function alert(organization, meter, { month, now, planName }) {
  const level = levelOf(meter);
  const period = meter.monthly ? month : 'always';
  const path = `usageAlerts.${meter.metric}`;
  const stored = organization.usageAlerts?.[meter.metric] || null;
  const storedLevel = stored && stored.period === period ? stored.level : 0;
  const sameAsStored = stored ? { [`${path}.level`]: stored.level, [`${path}.period`]: stored.period } : { [path]: { $exists: false } };
  if (level <= storedLevel) {
    if (!level && stored && !meter.monthly) await Organization.updateOne({ _id: organization._id, ...sameAsStored }, { $unset: { [path]: 1 } });
    return false;
  }
  const { modifiedCount } = await Organization.updateOne({ _id: organization._id, ...sameAsStored }, { $set: { [path]: { level, period } } });
  if (!modifiedCount) return false;
  await notify(organization._id, await managersOf(organization._id), { ...noteFor(meter, level, planName, now), link: PLAN_LINK, source: 'usage' });
  return true;
}

async function checkOrganization(organization, { day, month, now }) {
  const snapshotDue = organization.usageSnapshotOn !== day;
  const meters = await metersOf(organization, { counted: snapshotDue });
  const result = { snapshot: false, alerts: 0 };
  if (snapshotDue) result.snapshot = await snapshot(organization, meters, { day, now });
  if (planService.subscriptionOf(organization, now).locked) return result; // the lock banner already says it
  const planName = planService.effectivePlanOf(organization, now).name;
  for (const meter of meters.filter((m) => m.group === 'limit' && m.limit !== null)) {
    if (await alert(organization, meter, { month, now, planName })) result.alerts += 1;
  }
  return result;
}

const BATCH = 200;
async function run({ now } = {}) {
  const at = now ? new Date(now) : new Date();
  const day = indiaDate(0, at);
  const totals = { companies: 0, snapshots: 0, alerts: 0 };
  let lastId = null;
  for (;;) {
    const batch = await Organization.find({ 'deletion.scheduledFor': null, ...(lastId && { _id: { $gt: lastId } }) })
      .sort({ _id: 1 }).limit(BATCH).select('plan subscription entitlementGrants usageSnapshotOn usageAlerts');
    if (!batch.length) break;
    for (const organization of batch) {
      try {
        const result = await checkOrganization(organization, { day, month: day.slice(0, 7), now: at });
        totals.companies += 1;
        if (result.snapshot) totals.snapshots += 1;
        totals.alerts += result.alerts;
      } catch (error) {
        logger.error(`Usage check for ${organization._id} failed: ${error.message}`);
      }
    }
    lastId = batch[batch.length - 1]._id;
    if (batch.length < BATCH) break;
  }
  return totals;
}

function register(queue) {
  queue.define(JOB, () => run(), { maxAttempts: 2 });
  queue.every(JOB, 60 * 60 * 1000).catch((error) => logger.error(`Scheduling ${JOB} failed: ${error.message}`));
}

module.exports = { JOB, metersOf, history, run, register, levelOf, noteFor, ORDER, AI_METRIC };
