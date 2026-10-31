const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Ticket = require('../models/Ticket');
const logger = require('../config/logger');
const { audit } = require('../utils/audit');
const { rangeOf } = require('../utils/reportRange');
const { businessHoursOf, addWorkingMinutes, workingMinutesBetween } = require('../utils/businessHours');
const { isManager, canViewAll } = require('../constants/permissions');
const { TICKET_STATUSES, TICKET_PRIORITIES, TICKET_CLOSED_STATUSES, TICKET_SLA_DEFAULTS } = require('../constants/crm');
const notificationService = require('./notificationService');

// Ticket SLA (G3, D107): by priority, how soon a ticket gets its first reply and how soon it is
// resolved — in the company's working hours unless switched off; on by default with the limits in
// constants/crm.js. The due times are set when a ticket is made (and again, from then, when its
// priority changes). Waiting on Customer stops the resolution's clock, and so does Resolved or
// Closed until the ticket is reopened: its due time moves on by the time waited. The first reply
// is the first note on the ticket, putting it on Waiting on Customer, or resolving it. A check
// every 5 minutes marks what was missed and tells the ticket's person and the owners and admins
// under the bell (once for each miss). Tickets made before the SLA, or while it was off, have none.
const JOB = 'tickets.sla';
const CHECK_EVERY_MS = 5 * 60 * 1000;
const BATCH = 500;
const WAITING = 'Waiting on Customer';
const closed = (status) => TICKET_CLOSED_STATUSES.includes(status);
const stops = (status) => status === WAITING || closed(status);
const OPEN_STATUSES = TICKET_STATUSES.filter((status) => !closed(status));

// The company's settings, with the defaults for what it did not set.
function settingsOf(organization) {
  const saved = organization?.settings?.ticketSla || {};
  const limits = {};
  for (const priority of TICKET_PRIORITIES) {
    const own = saved.limits?.[priority] || {};
    limits[priority] = {
      reply: Number.isFinite(own.reply) ? own.reply : TICKET_SLA_DEFAULTS[priority].reply,
      resolve: Number.isFinite(own.resolve) ? own.resolve : TICKET_SLA_DEFAULTS[priority].resolve,
    };
  }
  return { enabled: saved.enabled !== false, workingHoursOnly: saved.workingHoursOnly !== false, limits };
}

async function loadSettings(organizationId) {
  const organization = await Organization.findById(organizationId).select('settings.ticketSla businessHours').lean();
  return { settings: settingsOf(organization), hours: businessHoursOf(organization) };
}

// The SLA's clock: minutes of the company's working hours, or every minute.
function clockOf(workingHours, hours) {
  return {
    after: (start, minutes) => (workingHours ? addWorkingMinutes(hours, start, minutes) : new Date(start.getTime() + minutes * 60 * 1000)),
    between: (from, to) => (workingHours ? workingMinutesBetween(hours, from, to) : Math.max(Math.round((to - from) / 60000), 0)),
  };
}

// The wait is over: if there was time left when it began, the resolution's due time moves on by
// the minutes waited.
function resume(ticket, clock, now) {
  const pausedAt = ticket.get('sla.pausedAt');
  let resolveDueAt = ticket.get('sla.resolveDueAt');
  if (pausedAt < resolveDueAt) {
    const waited = clock.between(pausedAt, now);
    if (waited > 0) {
      resolveDueAt = clock.after(resolveDueAt, waited);
      ticket.set('sla.resolveDueAt', resolveDueAt);
      ticket.set('sla.pausedMinutes', (ticket.get('sla.pausedMinutes') || 0) + waited);
    }
  }
  if (ticket.get('sla.resolveBreachedAt') && resolveDueAt > now) ticket.set('sla.resolveBreachedAt', undefined);
  ticket.set('sla.pausedAt', undefined);
}

// Called before a ticket is saved (ticketService): a new one gets its due times; a changed one
// follows its new priority (that priority's limits from when it was made, the waits still not
// counting; a miss stays a miss only if the new time has passed too) and its status (the pauses,
// the first reply).
async function apply(organizationId, ticket, now = new Date()) {
  const isNew = ticket.isNew;
  if (!isNew && !(ticket.get('sla.replyDueAt') && (ticket.isModified('priority') || ticket.isModified('status')))) return;
  const { settings, hours } = await loadSettings(organizationId);
  const limit = settings.limits[ticket.priority] || settings.limits.Medium;
  if (isNew) {
    if (!settings.enabled) return;
    const clock = clockOf(settings.workingHoursOnly, hours);
    ticket.sla = {
      replyDueAt: clock.after(now, limit.reply),
      resolveDueAt: clock.after(now, limit.resolve),
      workingHours: settings.workingHoursOnly,
      ...(stops(ticket.status) && { firstReplyAt: now, pausedAt: now }),
    };
    return;
  }
  const clock = clockOf(ticket.get('sla.workingHours'), hours);
  if (ticket.isModified('priority') && settings.enabled) {
    const replyDueAt = clock.after(ticket.createdAt, limit.reply);
    const resolveDueAt = clock.after(ticket.createdAt, limit.resolve + (ticket.get('sla.pausedMinutes') || 0));
    ticket.set('sla.replyDueAt', replyDueAt);
    ticket.set('sla.resolveDueAt', resolveDueAt);
    if (replyDueAt > now) ticket.set('sla.replyBreachedAt', undefined);
    if (resolveDueAt > now) ticket.set('sla.resolveBreachedAt', undefined);
  }
  if (ticket.isModified('status')) {
    if (ticket.get('sla.pausedAt')) resume(ticket, clock, now);
    if (stops(ticket.status)) {
      ticket.set('sla.pausedAt', now);
      if (!ticket.get('sla.firstReplyAt')) ticket.set('sla.firstReplyAt', now);
    }
  }
}

// A note on the ticket: its first reply, if it had none.
async function noteAdded(ticket, at = new Date()) {
  if (!ticket.sla?.replyDueAt || ticket.sla.firstReplyAt) return;
  await Ticket.updateOne({ _id: ticket._id, 'sla.firstReplyAt': null }, { $set: { 'sla.firstReplyAt': at } }, { timestamps: false });
}

// For the pages: { reply: { dueAt, at, state }, resolve: { dueAt, at, state }, workingHours } or
// null. state: due (time left), breached (missed, still open), met, late (done after the time),
// paused (the resolution, while it waits on the customer).
function slaOf(ticket, now = new Date()) {
  const { sla } = ticket;
  if (!sla?.replyDueAt) return null;
  const replyAt = sla.firstReplyAt || null;
  const resolveAt = closed(ticket.status) ? ticket.resolvedAt || sla.pausedAt || null : null;
  let resolveState = now > sla.resolveDueAt ? 'breached' : 'due';
  if (resolveAt) resolveState = resolveAt <= sla.resolveDueAt ? 'met' : 'late';
  else if (sla.pausedAt) resolveState = 'paused';
  return {
    reply: { dueAt: sla.replyDueAt, at: replyAt, state: replyAt ? (replyAt <= sla.replyDueAt ? 'met' : 'late') : now > sla.replyDueAt ? 'breached' : 'due' },
    resolve: { dueAt: sla.resolveDueAt, at: resolveAt, state: resolveState },
    workingHours: Boolean(sla.workingHours),
  };
}

// --- the check every 5 minutes ----------------------------------------------------------------
async function companyOf(cache, organizationId) {
  const key = String(organizationId);
  if (!cache.has(key)) {
    const [organization, managers] = await Promise.all([
      Organization.findById(organizationId).select('businessHours').lean(),
      OrganizationMember.find({ organizationId, status: 'active', role: { $in: ['owner', 'admin'] } }).select('_id').lean(),
    ]);
    cache.set(key, { timezone: businessHoursOf(organization).timezone, managers: managers.map((m) => m._id) });
  }
  return cache.get(key);
}

async function tell(ticket, kind, cache) {
  const { timezone, managers } = await companyOf(cache, ticket.organizationId);
  const people = new Map(managers.map((id) => [String(id), id]));
  if (ticket.assigneeId) people.set(String(ticket.assigneeId), ticket.assigneeId);
  const reply = kind === 'reply';
  const due = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: timezone })
    .format(reply ? ticket.sla.replyDueAt : ticket.sla.resolveDueAt);
  await notificationService.notify(ticket.organizationId, [...people.values()], {
    title: `Ticket #${ticket.number}: ${reply ? 'first reply' : 'resolution'} time missed`,
    body: `${ticket.subject} (${ticket.priority}): ${reply ? 'the first reply' : 'resolving it'} was due by ${due}.`,
    link: `Support.html?open=${ticket._id}`,
    source: 'support',
  });
}

// Marks what is missed now and tells (each miss once: the mark comes first, so two servers never
// both tell). Companies that switched the SLA off are left out.
async function checkBreaches(now = new Date()) {
  const off = await Organization.distinct('_id', { 'settings.ticketSla.enabled': false });
  const open = { status: { $in: OPEN_STATUSES }, ...(off.length && { organizationId: { $nin: off } }) };
  const kinds = [
    ['reply', 'sla.replyBreachedAt', { ...open, 'sla.replyDueAt': { $lte: now }, 'sla.firstReplyAt': null, 'sla.replyBreachedAt': null }],
    ['resolve', 'sla.resolveBreachedAt', { ...open, 'sla.resolveDueAt': { $lte: now }, 'sla.pausedAt': null, 'sla.resolveBreachedAt': null }],
  ];
  const cache = new Map();
  let told = 0;
  for (const [kind, field, filter] of kinds) {
    for (const ticket of await Ticket.find(filter).limit(BATCH).lean()) {
      const { modifiedCount } = await Ticket.updateOne({ _id: ticket._id, ...filter }, { $set: { [field]: now } }, { timestamps: false });
      if (!modifiedCount) continue;
      try {
        await tell(ticket, kind, cache);
        told += 1;
      } catch (error) {
        logger.error(`SLA note for ticket ${ticket._id} failed: ${error.message}`);
      }
    }
  }
  return { told };
}

function register(queue) {
  queue.define(JOB, () => checkBreaches(), { maxAttempts: 1 });
  queue.every(JOB, CHECK_EVERY_MS).catch((error) => logger.error(`Scheduling ${JOB} failed: ${error.message}`));
}

// --- the settings (GET/PATCH /ticket-sla) -----------------------------------------------------
async function get(req) {
  const organization = await Organization.findById(req.tenant.organizationId).select('settings.ticketSla businessHours').lean();
  const hours = businessHoursOf(organization);
  return {
    ...settingsOf(organization),
    defaults: TICKET_SLA_DEFAULTS,
    businessHours: { days: hours.days, start: hours.start, end: hours.end, timezone: hours.timezone },
  };
}

async function update(req, body) {
  const organizationId = req.tenant.organizationId;
  const before = settingsOf(await Organization.findById(organizationId).select('settings.ticketSla').lean());
  const after = {
    enabled: body.enabled ?? before.enabled,
    workingHoursOnly: body.workingHoursOnly ?? before.workingHoursOnly,
    limits: { ...before.limits, ...body.limits },
  };
  await Organization.updateOne({ _id: organizationId }, { $set: { 'settings.ticketSla': after } });
  await audit(req, { action: 'ticket_sla.updated', entityType: 'Organization', entityId: organizationId, changes: { before, after } });
  return get(req);
}

// --- the report (GET /reports/sla) ------------------------------------------------------------
const rate = (met, total) => (total ? Math.round((met / total) * 1000) / 10 : null);
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

// Tickets with an SLA made in the range: overall, by priority and by person, how many first
// replies and resolutions were in time (met), after it (late), are missed and still open
// (breached), still have time (due) or wait on the customer (paused); met % leaves out the last
// two. The first reply's time is counted on the SLA's clock (working minutes, when it uses them).
// Members who may not see every ticket see their own.
async function report(req, query) {
  const range = rangeOf(query);
  const organizationId = req.tenant.organizationId;
  const own = isManager(req.member) || canViewAll(req.member, 'support') || canViewAll(req.member, 'reports') ? null : req.member._id;
  const [tickets, { settings, hours }, members] = await Promise.all([
    Ticket.find({ organizationId, createdAt: { $gte: range.start, $lt: range.end }, 'sla.replyDueAt': { $type: 'date' }, ...(own && { assigneeId: own }) })
      .select('priority status assigneeId sla resolvedAt createdAt').lean(),
    loadSettings(organizationId),
    OrganizationMember.find({ organizationId }).populate('userId', 'name email').lean(),
  ]);
  const names = new Map(members.map((m) => [String(m._id), m.displayName || m.userId?.name || m.userId?.email || 'Member']));
  const blank = () => ({ tickets: 0, reply: { met: 0, late: 0, breached: 0, due: 0 }, resolve: { met: 0, late: 0, breached: 0, due: 0, paused: 0 }, replyMinutes: [] });
  const total = blank();
  const byPriority = Object.fromEntries(TICKET_PRIORITIES.map((priority) => [priority, blank()]));
  const byMember = new Map();
  const now = new Date();
  for (const ticket of tickets) {
    const sla = slaOf(ticket, now);
    const key = String(ticket.assigneeId || '');
    if (!byMember.has(key)) byMember.set(key, blank());
    const replyMinutes = sla.reply.at ? clockOf(sla.workingHours, hours).between(ticket.createdAt, sla.reply.at) : null;
    for (const bucket of [total, byPriority[ticket.priority] || byPriority.Medium, byMember.get(key)]) {
      bucket.tickets += 1;
      bucket.reply[sla.reply.state] += 1;
      bucket.resolve[sla.resolve.state] += 1;
      if (replyMinutes !== null) bucket.replyMinutes.push(replyMinutes);
    }
  }
  const summary = ({ replyMinutes, ...b }) => ({
    tickets: b.tickets,
    reply: { ...b.reply, metPct: rate(b.reply.met, b.reply.met + b.reply.late + b.reply.breached) },
    resolve: { ...b.resolve, metPct: rate(b.resolve.met, b.resolve.met + b.resolve.late + b.resolve.breached) },
    firstReplyMedianMinutes: median(replyMinutes),
  });
  return {
    range: { from: range.from, to: range.to },
    enabled: settings.enabled,
    workingHoursOnly: settings.workingHoursOnly,
    total: summary(total),
    byPriority: TICKET_PRIORITIES.map((priority) => ({ priority, ...summary(byPriority[priority]) })).reverse(),
    byMember: [...byMember.entries()]
      .map(([memberId, b]) => ({ memberId: memberId || null, name: memberId ? names.get(memberId) || 'Member' : null, ...summary(b) }))
      .sort((a, b) => b.tickets - a.tickets),
  };
}

module.exports = { JOB, OPEN_STATUSES, settingsOf, apply, noteAdded, slaOf, checkBreaches, register, get, update, report };
