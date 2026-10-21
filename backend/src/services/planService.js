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
const { audit } = require('../utils/audit');
const { PLANS, PLAN_KEYS, TRIAL_PLAN, TRIAL_DAYS, PLAN_GST_PCT, LIMITS, FEATURES, INCLUDED, planOf } = require('../constants/plans');

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
    // A checkout that was started but not paid yet (to finish it from Settings → Plan & usage).
    checkoutUrl: sub.gatewayStatus === 'created' && sub.checkoutUrl ? sub.checkoutUrl : null,
    // Paid for with the first charge still ahead (chosen during the trial: it starts at its end).
    firstChargeAt: sub.gatewayStatus === 'authenticated' ? sub.currentPeriodEnd || null : null,
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

// --- extras on top of the plan (Phase 3A, D80) -------------------------------------------------------
// The platform owner can give one company more of a limit, or a feature its plan lacks, until a
// date or for good (scripts/plan.js). Every check below uses the plan plus the grants in force.
const grantsInForce = (organization, now = new Date()) => (organization?.entitlementGrants || []).filter((grant) => !grant.until || grant.until > now);

function effectivePlanOf(organization, now = new Date()) {
  const plan = planOf(organization);
  const grants = grantsInForce(organization, now);
  if (!grants.length) return plan;
  const effective = { ...plan };
  for (const grant of grants) {
    if (LIMITS[grant.key] && Number.isFinite(effective[grant.key])) effective[grant.key] += grant.extra || 0; // unlimited stays unlimited
    if (FEATURES[grant.key]) effective[grant.key] = true;
  }
  return effective;
}

// For each limit with grants in force: how much extra, and when the first of them ends (null: none
// ends). A limit the plan does not have gets nothing.
function extrasOf(organization, now = new Date()) {
  const plan = planOf(organization);
  const extras = {};
  for (const grant of grantsInForce(organization, now)) {
    if (!LIMITS[grant.key] || !Number.isFinite(plan[grant.key])) continue;
    const entry = extras[grant.key] || { extra: 0, until: null, forGood: false };
    entry.extra += grant.extra || 0;
    if (!grant.until) entry.forGood = true;
    else if (!entry.until || grant.until < entry.until) entry.until = grant.until;
    extras[grant.key] = entry;
  }
  return extras;
}

function featureBlock(organization, feature) {
  const plan = effectivePlanOf(organization);
  if (subscriptionOf(organization).locked) return lockedMessage(organization, `use ${FEATURES[feature].replace(/^(The|Payment|Automation|An)\b/, (word) => word.toLowerCase())}`);
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
  agents: async (organizationId) => {
    const [members, invites] = await Promise.all([
      OrganizationMember.countDocuments({ organizationId, status: 'active', role: 'agent' }),
      Invite.countDocuments({ organizationId, status: 'pending', role: 'agent', expiresAt: { $gt: new Date() } }),
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
  const plan = effectivePlanOf(organization);
  const limit = limitOf(plan, metric);
  const used = await COUNTERS[metric](organization._id);
  const extra = extrasOf(organization)[metric]?.extra || 0;
  return { plan: plan.name, limit, extra, used, left: limit === null ? null : Math.max(limit - used, 0), locked: subscriptionOf(organization).locked, organization };
}

function limitMessage(room, metric, adding) {
  const { noun } = LIMITS[metric];
  const base = `The ${room.plan} plan${room.extra ? ` with its ${number(room.extra)} extra` : ''} allows ${number(room.limit)} ${noun}`;
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
    included: INCLUDED, // what every plan has (D67)
    gstPct: PLAN_GST_PCT,
    trialDays: TRIAL_DAYS,
    trialPlan: TRIAL_PLAN, // a new company tries this plan first
  };
}

const planKeyOf = (organization) => PLAN_KEYS.find((k) => PLANS[k] === planOf(organization));

async function organizationOfReq(req) {
  const organization = await Organization.findById(req.tenant.organizationId);
  if (!organization) throw httpError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
  return organization;
}

// GET /billing/subscription — everyone sees the plan and its state (for the banner); owners and
// admins also see the usage meters: the plan's limits (with any extra), the AI budget and what is
// counted without a limit (Phase 3A).
async function summary(req) {
  const organization = await organizationOfReq(req);
  const manager = ['owner', 'admin'].includes(req.member?.role);
  return {
    plan: serializePlan(planKeyOf(organization)),
    subscription: subscriptionOf(organization),
    // A company set to be deleted (Phase 10F): every page says so.
    deletion: organization.deletion?.scheduledFor ? { scheduledFor: organization.deletion.scheduledFor, requestedAt: organization.deletion.requestedAt } : null,
    ...(manager && { usage: await require('./usageService').metersOf(organization) }), // eslint-disable-line global-require
  };
}

// GET /billing/entitlements (Phase 3A, every member): what the company may use and why — each
// feature on or off with the cheapest plan that has it, and each limit with its extra. No usage
// numbers here (those are for owners and admins). The server checks all of it on its own; this
// only lets a page say "comes with the Growth plan" before someone clicks.
async function entitlements(req) {
  const organization = await organizationOfReq(req);
  const base = planOf(organization);
  const effective = effectivePlanOf(organization);
  const grants = grantsInForce(organization);
  const extras = extrasOf(organization);
  const sub = subscriptionOf(organization);
  const grantEnd = (key) => {
    const own = grants.filter((grant) => grant.key === key);
    return own.some((grant) => !grant.until) ? null : own.map((grant) => grant.until).sort((a, b) => a - b)[0] || null;
  };
  return {
    plan: { key: planKeyOf(organization), name: base.name },
    status: sub.status,
    locked: sub.locked,
    features: Object.entries(FEATURES).map(([feature, label]) => {
      const fromGrant = !base[feature] && Boolean(effective[feature]);
      const neededKey = base[feature] || fromGrant ? null : PLAN_KEYS.find((key) => PLANS[key][feature]);
      const block = featureBlock(organization, feature);
      return {
        key: feature,
        label,
        on: !block,
        from: base[feature] ? 'plan' : fromGrant ? 'grant' : null,
        until: fromGrant ? grantEnd(feature) : null,
        needs: neededKey ? { key: neededKey, name: PLANS[neededKey].name } : null,
        message: block,
      };
    }),
    limits: Object.entries(LIMITS).map(([metric, { label }]) => ({
      metric,
      label,
      limit: limitOf(effective, metric),
      extra: extras[metric]?.extra || 0,
      until: extras[metric] && !extras[metric].forGood ? extras[metric].until : null,
    })),
  };
}

// --- grants (the platform owner's scripts/plan.js; audited) ----------------------------------------
const GRANT_KEYS = Object.freeze([...Object.keys(LIMITS), ...Object.keys(FEATURES)]);
// Who did it, for the audit log (there is no signed-in user behind the command).
const platformReq = (by) => ({ ip: '', get: () => `scripts/plan.js (${by})` });

async function grant(organizationId, { key, extra, days, reason = '', by = 'platform' } = {}, now = new Date()) {
  if (!GRANT_KEYS.includes(key)) throw httpError(400, 'VALIDATION_ERROR', `The key is one of: ${GRANT_KEYS.join(', ')}.`);
  const limit = Boolean(LIMITS[key]);
  if (limit && !(Number.isInteger(extra) && extra >= 1 && extra <= 10000000)) throw httpError(400, 'VALIDATION_ERROR', 'Give how many extra (a whole number from 1 to 1,00,00,000).');
  if (!limit && extra !== undefined && extra !== null) throw httpError(400, 'VALIDATION_ERROR', `${key} is a feature: it is switched on, with no number.`);
  if (days !== undefined && days !== null && !(Number.isInteger(days) && days >= 1 && days <= 3650)) throw httpError(400, 'VALIDATION_ERROR', 'Give the days as a whole number from 1 to 3650, or leave them out for good.');
  const entry = {
    _id: new mongoose.Types.ObjectId(),
    key,
    ...(limit && { extra }),
    ...(days && { until: new Date(now.getTime() + days * DAY_MS) }),
    reason: String(reason || '').trim().slice(0, 200),
    by: String(by || 'platform').trim().slice(0, 100) || 'platform',
    at: now,
  };
  const organization = mongoose.isValidObjectId(organizationId)
    ? await Organization.findOneAndUpdate({ _id: organizationId }, { $push: { entitlementGrants: entry } }, { returnDocument: 'after' })
    : null;
  if (!organization) throw httpError(404, 'ORGANIZATION_NOT_FOUND', 'No company with that id.');
  // "key" would be redacted by the audit log (it hides anything named like a key), so: entitlement.
  await audit(platformReq(entry.by), {
    organizationId: organization._id, action: 'entitlement.granted', entityType: 'Organization', entityId: organization._id,
    changes: { grantId: String(entry._id), entitlement: key, extra: entry.extra ?? null, until: entry.until ?? null, reason: entry.reason, by: entry.by },
  });
  return entry;
}

async function revokeGrant(organizationId, grantId, { by = 'platform' } = {}) {
  if (!mongoose.isValidObjectId(organizationId) || !mongoose.isValidObjectId(grantId)) throw httpError(404, 'GRANT_NOT_FOUND', 'No such grant.');
  const before = await Organization.findOneAndUpdate(
    { _id: organizationId, 'entitlementGrants._id': grantId },
    { $pull: { entitlementGrants: { _id: grantId } } },
    { returnDocument: 'before' },
  );
  if (!before) throw httpError(404, 'GRANT_NOT_FOUND', 'No such grant.');
  const removed = before.entitlementGrants.id(grantId);
  await audit(platformReq(by), {
    organizationId: before._id, action: 'entitlement.revoked', entityType: 'Organization', entityId: before._id,
    changes: { grantId: String(grantId), entitlement: removed.key, extra: removed.extra ?? null, until: removed.until ?? null, by },
  });
  return removed.toObject();
}

module.exports = {
  effectivePlanOf,
  extrasOf,
  grantsInForce,
  entitlements,
  grant,
  revokeGrant,
  GRANT_KEYS,
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
