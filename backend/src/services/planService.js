const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Invite = require('../models/Invite');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Contact = require('../models/Contact');
const Broadcast = require('../models/Broadcast');
const Quotation = require('../models/Quotation');
const MessageTemplate = require('../models/MessageTemplate');
const httpError = require('../utils/httpError');
const { PLANS, PLAN_KEYS, TRIAL_PLAN, TRIAL_DAYS, PLAN_GST_PCT, LIMITS, FEATURES, planOf } = require('../constants/plans');

// The SaaS plan of an organization (Phase 10): its subscription state, its limits and what has
// been used, and the checks the services call before adding something the plan counts.
// Usage is counted from the records (like the reports, D47), so it can never drift.
// Locked (trial over without a plan, or the subscription ended): reading, replying to customers,
// receiving messages and leads and recording payments keep working; adding users, numbers,
// contacts, templates, quotations, broadcasts and the paid features stops until a plan is
// chosen. Nothing is deleted (D49).
const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_HINT = 'Choose a plan in Settings → Plan & usage.';
const UPGRADE_HINT = 'Upgrade in Settings → Plan & usage.';
const LOCKED_STATES = ['expired', 'halted'];

const objectId = (id) => new mongoose.Types.ObjectId(String(id));
const dateText = (date) => new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const number = (value) => Number(value).toLocaleString('en-IN');

// The first moment of this month in India time.
function monthStart(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 330 * 60 * 1000);
}

// What a new organization starts with (sign-up).
function trialFields(now = new Date()) {
  return { plan: TRIAL_PLAN, subscription: { status: 'trialing', since: now, trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * DAY_MS) } };
}

// Where the subscription stands now: a trial past its end is expired, and so is a cancelled
// subscription past its paid period.
function subscriptionOf(organization, now = new Date()) {
  const sub = organization?.subscription || {};
  let status = sub.status || 'comped';
  if (status === 'trialing' && sub.trialEndsAt && sub.trialEndsAt <= now) status = 'expired';
  if (status === 'cancelled' && (!sub.currentPeriodEnd || sub.currentPeriodEnd <= now)) status = 'expired';
  const trialEndsAt = sub.trialEndsAt || null;
  const daysLeft = status === 'trialing' && trialEndsAt ? Math.max(Math.ceil((trialEndsAt - now) / DAY_MS), 0) : null;
  return {
    status,
    locked: LOCKED_STATES.includes(status),
    trialEndsAt,
    daysLeft,
    wasTrial: (sub.status || '') === 'trialing',
    currentPeriodEnd: sub.currentPeriodEnd || null,
    cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    pendingPlan: sub.pendingPlan || null,
    provider: sub.provider || null,
  };
}

function lockedMessage(organization, action = 'do this') {
  const sub = subscriptionOf(organization);
  const why = sub.wasTrial && sub.trialEndsAt
    ? `Your free trial ended on ${dateText(sub.trialEndsAt)}`
    : sub.status === 'halted' ? 'Your subscription payment did not go through' : 'Your subscription has ended';
  return `${why}, so you cannot ${action} now. Everything you have stays available. ${PLAN_HINT}`;
}

// The cheapest plan that has a feature.
function cheapestPlanWith(feature) {
  return PLAN_KEYS.map((key) => PLANS[key]).find((plan) => plan[feature]) || null;
}

function featureBlock(organization, feature) {
  const plan = planOf(organization);
  if (subscriptionOf(organization).locked) return lockedMessage(organization, `use ${FEATURES[feature].replace(/^(The|Payment|Automation)\b/, (word) => word.toLowerCase())}`);
  if (plan[feature]) return '';
  const needed = cheapestPlanWith(feature);
  return `${FEATURES[feature]} ${/s$/.test(FEATURES[feature]) ? 'come' : 'comes'} with the ${needed?.name || 'higher'} plan and above (you are on ${plan.name}). ${UPGRADE_HINT}`;
}

const hasFeature = (organization, feature) => !featureBlock(organization, feature);

const organizationOf = async (organizationOrId) => (organizationOrId instanceof Organization ? organizationOrId : Organization.findById(organizationOrId));

// Throws 403 PLAN_LIMIT (the plan lacks it) or SUBSCRIPTION_INACTIVE (locked).
async function assertFeature(organizationOrId, feature) {
  const organization = await organizationOf(organizationOrId);
  const block = featureBlock(organization, feature);
  if (block) throw httpError(403, subscriptionOf(organization).locked ? 'SUBSCRIPTION_INACTIVE' : 'PLAN_LIMIT', block, [{ field: feature, message: block }]);
}

// --- usage -----------------------------------------------------------------------------------------
const COUNTERS = {
  users: async (organizationId) => {
    const [members, invites] = await Promise.all([
      OrganizationMember.countDocuments({ organizationId, status: 'active' }),
      Invite.countDocuments({ organizationId, status: 'pending', expiresAt: { $gt: new Date() } }),
    ]);
    return members + invites;
  },
  whatsappNumbers: (organizationId) => WhatsAppAccount.countDocuments({ organizationId }),
  contacts: (organizationId) => Contact.countDocuments({ organizationId }),
  broadcastsPerMonth: (organizationId) => Broadcast.countDocuments({ organizationId, startedAt: { $gte: monthStart() } }),
  // Every quotation, estimate and pro-forma made this month, also those deleted since.
  quotesPerMonth: (organizationId) => Quotation.collection.countDocuments({ organizationId: objectId(organizationId), createdAt: { $gte: monthStart() } }),
  templates: (organizationId) => MessageTemplate.countDocuments({ organizationId }),
};

const limitOf = (plan, metric) => (Number.isFinite(plan[metric]) ? plan[metric] : null);

async function usageOf(organizationId, plan) {
  const counts = await Promise.all(Object.keys(LIMITS).map((metric) => COUNTERS[metric](organizationId)));
  return Object.keys(LIMITS).map((metric, index) => {
    const limit = limitOf(plan, metric);
    return { metric, label: LIMITS[metric].label, used: counts[index], limit, left: limit === null ? null : Math.max(limit - counts[index], 0), monthly: Boolean(LIMITS[metric].monthly) };
  });
}

// How many more of a metric the organization may add now ({ limit, used, left, locked }).
async function roomFor(organizationOrId, metric) {
  const organization = await organizationOf(organizationOrId);
  const plan = planOf(organization);
  const limit = limitOf(plan, metric);
  const used = await COUNTERS[metric](organization._id);
  return { plan: plan.name, limit, used, left: limit === null ? null : Math.max(limit - used, 0), locked: subscriptionOf(organization).locked, organization };
}

function limitMessage(room, metric, adding) {
  const { noun } = LIMITS[metric];
  const base = `The ${room.plan} plan allows ${number(room.limit)} ${noun}`;
  if (adding > 1 && room.left > 0) return `${base}; you have room for ${number(room.left)} more (${number(room.used)} used), not ${number(adding)}. ${UPGRADE_HINT}`;
  return `${base}, and ${LIMITS[metric].monthly ? "this month's are used up" : `you have ${number(room.used)}`}. ${UPGRADE_HINT}`;
}

// Throws before something counted is added: 403 SUBSCRIPTION_INACTIVE when locked, 403
// PLAN_LIMIT when it would go over the plan. adding: how many are about to be added.
async function assertRoom(organizationOrId, metric, { adding = 1, action } = {}) {
  if (adding <= 0) return;
  const room = await roomFor(organizationOrId, metric);
  if (room.locked) {
    const message = lockedMessage(room.organization, action || `add ${LIMITS[metric].noun.replace(/ a month$/, '')}`);
    throw httpError(403, 'SUBSCRIPTION_INACTIVE', message, [{ field: metric, message }]);
  }
  if (room.limit !== null && room.used + adding > room.limit) {
    const message = limitMessage(room, metric, adding);
    throw httpError(403, 'PLAN_LIMIT', message, [{ field: metric, message, limit: room.limit, used: room.used }]);
  }
}

// Throws SUBSCRIPTION_INACTIVE when locked (for actions that are not counted, e.g. a payment link).
async function assertActive(organizationOrId, action) {
  const organization = await organizationOf(organizationOrId);
  if (subscriptionOf(organization).locked) {
    const message = lockedMessage(organization, action);
    throw httpError(403, 'SUBSCRIPTION_INACTIVE', message, [{ field: 'subscription', message }]);
  }
}

// --- what the Plan & usage page and the banner read ------------------------------------------------
function serializePlan(key) {
  const plan = PLANS[key];
  const gstPaise = Math.round((plan.pricePaise * PLAN_GST_PCT) / 100);
  return {
    key,
    name: plan.name,
    pricePaise: plan.pricePaise,
    gstPaise,
    totalPaise: plan.pricePaise + gstPaise,
    limits: Object.fromEntries(Object.keys(LIMITS).map((metric) => [metric, limitOf(plan, metric)])),
    features: Object.fromEntries(Object.keys(FEATURES).map((feature) => [feature, Boolean(plan[feature])])),
  };
}

function plans() {
  return {
    plans: PLAN_KEYS.map(serializePlan),
    limits: Object.entries(LIMITS).map(([metric, { label, monthly }]) => ({ metric, label: label.replace(/ this month$/, ' a month'), monthly: Boolean(monthly) })),
    features: Object.entries(FEATURES).map(([feature, label]) => ({ feature, label })),
    gstPct: PLAN_GST_PCT,
    trialDays: TRIAL_DAYS,
  };
}

// GET /billing/subscription — everyone sees the plan and its state (for the banner); owners and
// admins also see the usage meters.
async function summary(req) {
  const organization = await Organization.findById(req.tenant.organizationId);
  if (!organization) throw httpError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
  const plan = planOf(organization);
  const key = PLAN_KEYS.find((k) => PLANS[k] === plan);
  const manager = ['owner', 'admin'].includes(req.member?.role);
  return {
    plan: serializePlan(key),
    subscription: subscriptionOf(organization),
    ...(manager && { usage: await usageOf(organization._id, plan) }),
  };
}

module.exports = {
  monthStart,
  trialFields,
  subscriptionOf,
  featureBlock,
  hasFeature,
  assertFeature,
  assertRoom,
  assertActive,
  roomFor,
  usageOf,
  plans,
  summary,
  serializePlan,
  LOCKED_STATES,
};
