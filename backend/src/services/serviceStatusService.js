const mongoose = require('mongoose');
const env = require('../config/env');
const logger = require('../config/logger');
const Job = require('../models/Job');
const PaymentConnection = require('../models/PaymentConnection');
const PlatformSetting = require('../models/PlatformSetting');
const ServiceHealth = require('../models/ServiceHealth');
const ServiceIncident = require('../models/ServiceIncident');
const SocialAccount = require('../models/SocialAccount');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { indiaDate } = require('../utils/dates');
const { OUTSIDE_SERVICES, SERVICES, LEVEL_RANK } = require('../constants/serviceStatus');

// Is the CRM, and what it depends on, working? (Phase 9, D151; docs/RELIABILITY.md.) Every call to
// Meta, Razorpay and Cashfree is counted per minute (record); once a minute the job looks at the
// last 5 minutes and opens or closes an incident for a service. The gaps in the CRM's own
// heartbeat say when it was not running; jobs waiting too long say its background work is late.
// Incidents feed the public status page (GET /status), the banners inside the CRM (noticesFor),
// and the platform admin page; that page can also post a notice by hand.

const JOB = 'status.evaluate';
const MINUTE_MS = 60 * 1000;
const WINDOW_MS = 5 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
const HISTORY_DAYS = 30;
// An outside service is in trouble: at least 5 failed calls in 5 minutes, half of them or more.
const OPEN_MIN_FAILED = 5;
const OPEN_RATIO = 0.5;
const DOWN_RATIO = 0.9;
// It is back: 3 answers with under one failure in five; or, with nobody calling it, it answers a check.
const CLOSE_MIN_OK = 3;
const CLOSE_RATIO = 0.2;
const PROBE_TIMEOUT_MS = 10000;
const HEARTBEAT_KEY = 'statusHeartbeat';
const HEARTBEAT_GAP_MS = 4 * MINUTE_MS; // longer than a restart takes
const JOBS_LATE_MS = 15 * MINUTE_MS; // as GET /health says DEGRADED
const JOBS_OK_MS = 5 * MINUTE_MS;

const minuteOf = (date) => new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS);
const worse = (a, b) => ((LEVEL_RANK[b] || 0) > (LEVEL_RANK[a] || 0) ? b : a);

// One call's result. Never throws and never makes the caller wait.
function record(service, ok, detail = '') {
  if (!OUTSIDE_SERVICES.includes(service) || mongoose.connection.readyState !== 1) return;
  ServiceHealth.updateOne(
    { service, minute: minuteOf(new Date()) },
    { $inc: { [ok ? 'ok' : 'failed']: 1 }, ...(!ok && detail && { $set: { lastError: String(detail).slice(0, 200) } }) },
    { upsert: true },
  ).catch(() => {}); // two at once on a new minute: one count less
}

// --- what is open now (read on every page's banner check, so kept a moment) ---------------------
const KEEP_MS = 15 * 1000;
let openCache = null;
let publicCache = null;
function forget() {
  openCache = null;
  publicCache = null;
}

async function openIncidents() {
  if (openCache && Date.now() - openCache.at < KEEP_MS) return openCache.items;
  const items = await ServiceIncident.find({ endedAt: null }).sort({ startedAt: -1 }).lean();
  openCache = { at: Date.now(), items };
  return items;
}

const isDown = async (service) => (await openIncidents()).some((i) => i.service === service && i.level === 'down');
const hasTrouble = async (service) => (await openIncidents()).some((i) => i.service === service && i.level !== 'info');

const openOne = async ({ service, level, startedAt, source = 'auto', ...rest }) => {
  const incident = await ServiceIncident.create({ service, level, startedAt, source, ...rest });
  logger.warn(`Status: ${service} ${level} since ${startedAt.toISOString()}`);
  forget();
  return incident;
};
const closeOne = async (incident, now) => {
  await ServiceIncident.updateOne({ _id: incident._id, endedAt: null }, { $set: { endedAt: now } });
  logger.info(`Status: ${incident.service} is back`);
  forget();
};

// --- the check, once a minute ---------------------------------------------------------------------

// An outside service asked directly, when nobody has called it for a while: any answer below 500
// means it is up (a wrong or missing key is a fine answer here).
async function probe(service) {
  const urls = {
    whatsapp: `${env.whatsapp.graphUrl}/${env.whatsapp.graphVersion}/`,
    razorpay: 'https://api.razorpay.com/v1/',
    cashfree: 'https://api.cashfree.com/pg/',
  };
  try {
    const response = await fetch(urls[service], { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function checkOutside(service, now, { ask = probe } = {}) {
  const rows = await ServiceHealth.find({ service, minute: { $gte: minuteOf(new Date(now.getTime() - WINDOW_MS)) } }).lean();
  const ok = rows.reduce((n, r) => n + r.ok, 0);
  const failed = rows.reduce((n, r) => n + r.failed, 0);
  const ratio = ok + failed ? failed / (ok + failed) : 0;
  const open = await ServiceIncident.findOne({ service, source: 'auto', endedAt: null }).lean();
  if (!open) {
    if (failed >= OPEN_MIN_FAILED && ratio >= OPEN_RATIO) {
      const first = rows.filter((r) => r.failed).map((r) => r.minute).sort((a, b) => a - b)[0];
      await openOne({ service, level: ratio >= DOWN_RATIO ? 'down' : 'degraded', startedAt: first || now });
    }
    return;
  }
  const backByCalls = ok >= CLOSE_MIN_OK && ratio < CLOSE_RATIO;
  const backByCheck = !ok && !failed && await ask(service);
  if (backByCalls || backByCheck) {
    await closeOne(open, now);
    return;
  }
  const level = failed >= OPEN_MIN_FAILED && ratio >= DOWN_RATIO ? 'down' : 'degraded';
  if (ok + failed && level !== open.level) {
    await ServiceIncident.updateOne({ _id: open._id }, { $set: { level } });
    forget();
  }
}

// The CRM writes the time once a minute; a long gap means it was not running.
async function checkHeartbeat(now) {
  const beat = await PlatformSetting.findOne({ key: HEARTBEAT_KEY }).lean();
  const last = beat?.value?.at ? new Date(beat.value.at) : null;
  if (last && now - last > HEARTBEAT_GAP_MS) {
    await ServiceIncident.create({ service: 'crm', source: 'auto', level: 'down', startedAt: last, endedAt: now });
    logger.warn(`Status: the CRM was not running from ${last.toISOString()}`);
    forget();
  }
  await PlatformSetting.updateOne({ key: HEARTBEAT_KEY }, { $set: { value: { at: now } } }, { upsert: true });
}

// Background work waiting too long.
async function checkJobs(now) {
  const oldest = await Job.findOne({ status: 'queued', runAt: { $lte: now }, name: { $ne: JOB } }).sort({ runAt: 1 }).select('runAt').lean();
  const late = oldest ? now - oldest.runAt : 0;
  const open = await ServiceIncident.findOne({ service: 'jobs', source: 'auto', endedAt: null }).lean();
  if (!open && late > JOBS_LATE_MS) await openOne({ service: 'jobs', level: 'degraded', startedAt: oldest.runAt });
  if (open && late < JOBS_OK_MS) await closeOne(open, now);
}

// Notices whose time is over.
async function endExpired(now) {
  const { modifiedCount } = await ServiceIncident.collection.updateMany({ endedAt: null, until: { $lte: now } }, [{ $set: { endedAt: '$until' } }]);
  if (modifiedCount) forget();
}

async function evaluate({ now = new Date(), ask = probe } = {}) {
  await checkHeartbeat(now);
  await checkJobs(now);
  await endExpired(now);
  for (const service of OUTSIDE_SERVICES) await checkOutside(service, now, { ask });
}

// --- the public status page ------------------------------------------------------------------------

const publicWords = (words) => ({ en: words?.en || '', hi: words?.hi || '' });
const noticeOf = (i) => ({ id: String(i._id), service: i.service, source: i.source, level: i.level, title: publicWords(i.title), body: publicWords(i.body), startedAt: i.startedAt, until: i.until || null });

// One service over the last 30 days in India's days, oldest first: 0 fine, 1 trouble, 2 down.
function daysOf(incidents, now) {
  return Array.from({ length: HISTORY_DAYS }, (_, index) => {
    const date = indiaDate(index - HISTORY_DAYS + 1, now);
    const from = new Date(`${date}T00:00:00+05:30`).getTime();
    const to = from + DAY_MS;
    const seen = incidents.filter((i) => i.level !== 'info' && new Date(i.startedAt).getTime() < to && new Date(i.endedAt || now).getTime() > from);
    return { date, level: seen.reduce((n, i) => Math.max(n, LEVEL_RANK[i.level]), 0) };
  });
}

function uptimeOf(incidents, now) {
  const from = now.getTime() - HISTORY_DAYS * DAY_MS;
  const down = incidents.filter((i) => i.level === 'down').reduce((sum, i) => sum + Math.max(0, new Date(i.endedAt || now).getTime() - Math.max(new Date(i.startedAt).getTime(), from)), 0);
  return Math.round(10000 * (1 - down / (HISTORY_DAYS * DAY_MS))) / 100;
}

// GET /status — no sign-in, nothing about any company.
async function publicStatus(now = new Date()) {
  if (publicCache && Date.now() - publicCache.at < KEEP_MS) return publicCache.value;
  const since = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);
  const incidents = await ServiceIncident.find({ $or: [{ endedAt: null }, { endedAt: { $gte: since } }] }).sort({ startedAt: -1 }).limit(300).lean();
  const open = incidents.filter((i) => !i.endedAt);
  const services = SERVICES.map((key) => {
    const own = incidents.filter((i) => i.service === key);
    const current = open.filter((i) => i.service === key && i.level !== 'info');
    return {
      key,
      status: current.reduce((level, i) => worse(level, i.level), 'ok'),
      since: current.length ? current.map((i) => i.startedAt).sort((a, b) => a - b)[0] : null,
      uptime: uptimeOf(own, now),
      days: daysOf(own, now).map((d) => d.level),
    };
  });
  const notices = open.filter((i) => i.source === 'manual').map(noticeOf);
  const value = {
    status: open.reduce((level, i) => worse(level, i.level === 'info' ? 'ok' : i.level), services.reduce((level, s) => worse(level, s.status), 'ok')),
    at: now.toISOString(),
    services,
    notices,
    incidents: incidents.filter((i) => i.level !== 'info').slice(0, 30).map((i) => ({
      id: String(i._id), service: i.service, source: i.source, level: i.level, title: publicWords(i.title), startedAt: i.startedAt, endedAt: i.endedAt,
      minutes: Math.max(1, Math.round((new Date(i.endedAt || now) - new Date(i.startedAt)) / MINUTE_MS)),
    })),
    days: Array.from({ length: HISTORY_DAYS }, (_, index) => indiaDate(index - HISTORY_DAYS + 1, now)),
  };
  publicCache = { at: Date.now(), value };
  return value;
}

// --- the banners inside the CRM ----------------------------------------------------------------------

// GET /status/notices: what is wrong now that matters to this company. The everyday answer (nothing
// open) costs no query of its own.
async function noticesFor(organizationId) {
  const open = await openIncidents();
  if (!open.length) return [];
  const needs = new Set(open.map((i) => i.service));
  const [chats, gateways] = await Promise.all([
    needs.has('whatsapp') ? Promise.all([WhatsAppAccount.exists({ organizationId }), SocialAccount.exists({ organizationId })]).then((found) => found.some(Boolean)) : false,
    needs.has('razorpay') || needs.has('cashfree') ? PaymentConnection.distinct('provider', { organizationId }) : [],
  ]);
  return open.filter((i) => {
    if (i.service === 'whatsapp') return chats;
    if (i.service === 'razorpay' || i.service === 'cashfree') return gateways.includes(i.service);
    return true;
  }).map(noticeOf);
}

// --- the platform admin page -----------------------------------------------------------------------

async function health(now = new Date()) {
  const since = minuteOf(new Date(now.getTime() - WINDOW_MS));
  const [rows, open, recent] = await Promise.all([
    ServiceHealth.find({ minute: { $gte: since } }).lean(),
    ServiceIncident.find({ endedAt: null }).sort({ startedAt: -1 }).lean(),
    ServiceIncident.find({ endedAt: { $ne: null } }).sort({ startedAt: -1 }).limit(20).lean(),
  ]);
  const serialize = (i) => ({ id: String(i._id), service: i.service, source: i.source, level: i.level, title: publicWords(i.title), body: publicWords(i.body), startedAt: i.startedAt, endedAt: i.endedAt, until: i.until || null, by: i.by || '' });
  return {
    services: OUTSIDE_SERVICES.map((key) => {
      const own = rows.filter((r) => r.service === key);
      return {
        key,
        status: open.filter((i) => i.service === key && i.level !== 'info').reduce((level, i) => worse(level, i.level), 'ok'),
        ok: own.reduce((n, r) => n + r.ok, 0),
        failed: own.reduce((n, r) => n + r.failed, 0),
        lastError: own.sort((a, b) => b.minute - a.minute).find((r) => r.lastError)?.lastError || '',
      };
    }),
    open: open.map(serialize),
    recent: recent.map(serialize),
  };
}

// POST /platform/notices — { service, level, title { en, hi }, body { en, hi }, untilHours }.
async function postNotice(req, { service = 'notice', level, title, body = {}, untilHours }) {
  const now = new Date();
  const incident = await ServiceIncident.create({
    service, source: 'manual', level, title, body, startedAt: now, by: req.user.email,
    ...(untilHours && { until: new Date(now.getTime() + untilHours * 60 * MINUTE_MS) }),
  });
  forget();
  await audit(req, { action: 'platform.notice_posted', entityType: 'ServiceIncident', entityId: incident._id, changes: { service, level } });
  return noticeOf(incident);
}

// POST /platform/incidents/:id/end
async function endIncident(req, id) {
  const { modifiedCount } = await ServiceIncident.updateOne({ _id: id, endedAt: null }, { $set: { endedAt: new Date() } });
  if (!modifiedCount) throw httpError(404, 'NOT_FOUND', 'That is not open.');
  forget();
  await audit(req, { action: 'platform.incident_ended', entityType: 'ServiceIncident', entityId: id });
}

function register(queue) {
  queue.define(JOB, () => evaluate(), { maxAttempts: 1 });
  queue.every(JOB, MINUTE_MS).catch((error) => logger.error(`Scheduling ${JOB} failed: ${error.message}`));
}

module.exports = { JOB, record, evaluate, openIncidents, isDown, hasTrouble, publicStatus, noticesFor, health, postNotice, endIncident, register, forget, probe };
