const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Contact = require('../models/Contact');
const Broadcast = require('../models/Broadcast');
const BillingInvoice = require('../models/BillingInvoice');
const Session = require('../models/Session');
const PlatformUnlock = require('../models/PlatformUnlock');
const env = require('../config/env');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { PLANS } = require('../constants/plans');
const planService = require('./planService');
const totpService = require('./totpService');
const emailService = require('./emailService');

// The platform admin page (D104): the platform's own people — the Google emails in
// PLATFORM_ADMIN_EMAILS, with 2-step login by the authenticator app — see every company as
// counts (never its customers, chats or files; no signing in as a company), the money (MRR, new
// companies, trial to paid, churn), comp a company, give a trial or change a plan (the actions of
// scripts/plan.js, written to that company's audit log), the platform's emails, and the go-live
// checklist with which keys this server has (never their values). The page opens for one login
// for 30 minutes after a code from the authenticator app.
const DAY_MS = 24 * 60 * 60 * 1000;
const UNLOCK_MS = 30 * 60 * 1000;
const PAYING = ['active', 'past_due'];

const listed = (user) => env.platformAdminEmails.includes(String(user?.email || '').toLowerCase());
const familyOf = async (req) => (await Session.findById(req.sessionId).select('familyId').lean())?.familyId || '';
const openUnlock = async (req) => {
  const familyId = await familyOf(req);
  return familyId ? PlatformUnlock.findOne({ userId: req.user._id, familyId, until: { $gt: new Date() } }).lean() : null;
};
const needsAuthenticator = () => httpError(403, 'PLATFORM_NEEDS_AUTHENTICATOR', 'Turn on 2-step login with an authenticator app first (Settings → Your profile → 2-step login).');

// GET /platform/status — anyone signed in: whether they are a platform admin and the page is open.
async function status(req) {
  if (!listed(req.user)) return { admin: false };
  const authenticator = totpService.enabled(req.user);
  const unlock = authenticator ? await openUnlock(req) : null;
  return { admin: true, authenticator, unlockedUntil: unlock?.until || null };
}

// Every other platform route: a listed admin, with the app, on a login that entered a code.
// Others get 404, as if there were no such page.
async function requireAdmin(req, res, next) {
  try {
    if (!listed(req.user)) throw httpError(404, 'NOT_FOUND', 'Not found');
    if (!totpService.enabled(req.user)) throw needsAuthenticator();
    if (!await openUnlock(req)) throw httpError(403, 'PLATFORM_CODE_REQUIRED', 'Enter a code from your authenticator app to open the platform admin page.');
    next();
  } catch (error) {
    next(error);
  }
}

// POST /platform/unlock { code } — the app's 6 digits (or a backup code): open for 30 minutes.
async function unlock(req, { code }) {
  if (!listed(req.user)) throw httpError(404, 'NOT_FOUND', 'Not found');
  if (!totpService.enabled(req.user)) throw needsAuthenticator();
  await totpService.checkCode(req.user, code);
  const familyId = await familyOf(req);
  if (!familyId) throw httpError(401, 'SESSION_ENDED', 'You were logged out on this device. Please log in again.');
  const until = new Date(Date.now() + UNLOCK_MS);
  await PlatformUnlock.findOneAndUpdate({ userId: req.user._id, familyId }, { $set: { until } }, { upsert: true });
  await audit(req, { action: 'platform.unlocked', entityType: 'User', entityId: req.user._id });
  logger.info(`Platform admin page opened by user ${req.user._id}`);
  return { unlockedUntil: until };
}

// POST /platform/lock — closes it on this login now.
async function lock(req) {
  await PlatformUnlock.deleteOne({ userId: req.user._id, familyId: await familyOf(req) });
  return { unlockedUntil: null };
}

// --- the money ---------------------------------------------------------------------------------
// When a paying company stopped: the end of the paid month for a cancellation, else the change.
const endedAt = (sub) => (sub?.status === 'cancelled' ? sub.currentPeriodEnd : sub?.since) || null;

// GET /platform/overview — MRR (plan prices before GST of active and payment-due companies),
// money in this month, new companies, trial to paid (companies of the last 90 days whose trial is
// over, comped ones left out: how many paid at least once) and churn (paying companies that
// stopped in the last 30 days, against those paying now plus them).
async function overview(now = new Date()) {
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const since90 = new Date(now.getTime() - 90 * DAY_MS);
  const monthStart = planService.monthStart(now);
  const [organizations, payers, thisMonth, emails] = await Promise.all([
    Organization.find().select('plan subscription createdAt deletion').lean(),
    BillingInvoice.distinct('organizationId'),
    BillingInvoice.aggregate([{ $match: { issuedAt: { $gte: monthStart } } }, { $group: { _id: null, totalPaise: { $sum: '$totalPaise' }, taxablePaise: { $sum: '$taxablePaise' }, invoices: { $sum: 1 } } }]),
    emailService.stats({ limit: 0 }),
  ]);
  const paid = new Set(payers.map(String));
  const companies = { total: organizations.length, trialing: 0, paying: 0, pastDue: 0, comped: 0, locked: 0, cancelling: 0, deletionScheduled: 0, new30Days: 0, newThisMonth: 0 };
  let mrrPaise = 0;
  const trial = { finished: 0, paid: 0 };
  const churn = { stopped: 0 };
  for (const organization of organizations) {
    const state = planService.subscriptionOf(organization, now);
    const sub = organization.subscription || {};
    if (state.status === 'trialing') companies.trialing += 1;
    if (PAYING.includes(state.status)) {
      companies.paying += 1;
      mrrPaise += PLANS[organization.plan]?.pricePaise || 0;
    }
    if (state.status === 'past_due') companies.pastDue += 1;
    if (state.status === 'comped') companies.comped += 1;
    if (state.locked) companies.locked += 1;
    if (state.cancelAtPeriodEnd || (sub.status === 'cancelled' && state.status === 'cancelled')) companies.cancelling += 1;
    if (organization.deletion?.scheduledFor) companies.deletionScheduled += 1;
    if (organization.createdAt >= since30) companies.new30Days += 1;
    if (organization.createdAt >= monthStart) companies.newThisMonth += 1;
    const id = String(organization._id);
    if (organization.createdAt >= since90 && state.status !== 'trialing' && state.status !== 'comped') {
      trial.finished += 1;
      if (paid.has(id)) trial.paid += 1;
    }
    const ended = endedAt(sub);
    if (paid.has(id) && ['expired', 'halted'].includes(state.status) && ended && ended >= since30 && ended <= now) churn.stopped += 1;
  }
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
  return {
    at: now,
    companies,
    mrrPaise,
    collectedThisMonth: { totalPaise: thisMonth[0]?.totalPaise || 0, taxablePaise: thisMonth[0]?.taxablePaise || 0, invoices: thisMonth[0]?.invoices || 0 },
    trialToPaid: { ...trial, pct: pct(trial.paid, trial.finished) },
    churn: { ...churn, base: companies.paying + churn.stopped, pct: pct(churn.stopped, companies.paying + churn.stopped) },
    emails: { enabled: emails.enabled, ...emails.totals },
  };
}

// --- the companies -----------------------------------------------------------------------------
// WhatsApp health of a company's numbers: error (one is in error or disconnected, or rated RED),
// warning (rated YELLOW, or no message from Meta for 7 days), ok, or none (no number).
function healthOf(row, now) {
  if (!row?.numbers) return { numbers: 0, connected: 0, health: 'none', quality: '', lastWebhookAt: null };
  const qualities = row.qualities.map((q) => String(q || '').toUpperCase());
  const quiet = !row.lastWebhookAt || now - row.lastWebhookAt > 7 * DAY_MS;
  const health = row.broken || qualities.includes('RED') ? 'error' : qualities.includes('YELLOW') || quiet ? 'warning' : 'ok';
  const quality = ['RED', 'YELLOW', 'GREEN'].find((q) => qualities.includes(q)) || '';
  return { numbers: row.numbers, connected: row.connected, health, quality, lastWebhookAt: row.lastWebhookAt || null };
}

const STATUS_FILTERS = {
  trialing: (s) => s.status === 'trialing',
  paying: (s) => PAYING.includes(s.status),
  past_due: (s) => s.status === 'past_due',
  locked: (s) => s.locked,
  comped: (s) => s.status === 'comped',
  cancelled: (s) => s.status === 'cancelled' || s.cancelAtPeriodEnd,
};

async function rowsFor(organizations, now) {
  const ids = organizations.map((o) => o._id);
  const byOrg = (rows) => new Map(rows.map((r) => [String(r._id), r]));
  const monthStart = planService.monthStart(now);
  const [members, owners, numbers, contacts, broadcasts, invoices] = await Promise.all([
    OrganizationMember.aggregate([{ $match: { organizationId: { $in: ids }, status: 'active' } }, { $group: { _id: '$organizationId', users: { $sum: 1 }, lastActiveAt: { $max: '$lastSeenAt' } } }]),
    OrganizationMember.find({ organizationId: { $in: ids }, role: 'owner', status: 'active' }).sort({ createdAt: 1 }).select('organizationId userId').populate({ path: 'userId', select: 'name email' }).lean(),
    WhatsAppAccount.aggregate([{ $match: { organizationId: { $in: ids } } }, {
      $group: {
        _id: '$organizationId', numbers: { $sum: 1 }, connected: { $sum: { $cond: [{ $eq: ['$status', 'connected'] }, 1, 0] } },
        broken: { $sum: { $cond: [{ $in: ['$status', ['error', 'disconnected']] }, 1, 0] } }, qualities: { $push: '$qualityRating' }, lastWebhookAt: { $max: '$lastWebhookAt' },
      },
    }]),
    Contact.aggregate([{ $match: { organizationId: { $in: ids }, deletedAt: null } }, { $group: { _id: '$organizationId', count: { $sum: 1 } } }]),
    Broadcast.aggregate([{ $match: { organizationId: { $in: ids }, startedAt: { $gte: monthStart } } }, { $group: { _id: '$organizationId', count: { $sum: 1 } } }]),
    BillingInvoice.aggregate([{ $match: { organizationId: { $in: ids } } }, { $group: { _id: '$organizationId', invoices: { $sum: 1 }, totalPaise: { $sum: '$totalPaise' }, lastPaidAt: { $max: '$issuedAt' } } }]),
  ]);
  const [m, n, c, b, i] = [byOrg(members), byOrg(numbers), byOrg(contacts), byOrg(broadcasts), byOrg(invoices)];
  const ownerOf = new Map();
  for (const owner of owners) if (!ownerOf.has(String(owner.organizationId))) ownerOf.set(String(owner.organizationId), owner.userId);
  return organizations.map((organization) => {
    const id = String(organization._id);
    const state = planService.subscriptionOf(organization, now);
    const owner = ownerOf.get(id);
    return {
      id,
      name: organization.name,
      createdAt: organization.createdAt,
      plan: organization.plan,
      planName: PLANS[organization.plan]?.name || organization.plan,
      status: state.status,
      locked: state.locked,
      trialEndsAt: state.trialEndsAt,
      daysLeft: state.daysLeft,
      currentPeriodEnd: state.currentPeriodEnd,
      cancelAtPeriodEnd: state.cancelAtPeriodEnd,
      deletionScheduledFor: organization.deletion?.scheduledFor || null,
      owner: owner ? { name: owner.name || '', email: owner.email || '' } : null,
      users: m.get(id)?.users || 0,
      lastActiveAt: m.get(id)?.lastActiveAt || null,
      whatsapp: healthOf(n.get(id), now),
      contacts: c.get(id)?.count || 0,
      broadcastsThisMonth: b.get(id)?.count || 0,
      paid: { invoices: i.get(id)?.invoices || 0, totalPaise: i.get(id)?.totalPaise || 0, lastPaidAt: i.get(id)?.lastPaidAt || null },
    };
  });
}

// GET /platform/companies?q=&status=&page=&limit= — newest first; q: a name or a company id.
async function companies({ q = '', status = '', page = 1, limit = 50 } = {}, now = new Date()) {
  const filter = {};
  const term = String(q).trim();
  if (term) {
    filter.$or = [{ name: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, ...(mongoose.isValidObjectId(term) ? [{ _id: term }] : [])];
  }
  let organizations = await Organization.find(filter).sort({ createdAt: -1 }).select('name plan subscription deletion createdAt').lean();
  if (STATUS_FILTERS[status]) organizations = organizations.filter((o) => STATUS_FILTERS[status](planService.subscriptionOf(o, now)));
  const total = organizations.length;
  const pageItems = organizations.slice((page - 1) * limit, page * limit);
  return { items: await rowsFor(pageItems, now), total, page, limit };
}

// POST /platform/companies/:id/actions { action: comp | trial | plan, days?, plan? }
async function act(req, id, { action, days, plan }) {
  const organization = mongoose.isValidObjectId(id) ? await Organization.findById(id).select('name plan subscription deletion createdAt') : null;
  if (!organization) throw httpError(404, 'NOT_FOUND', 'Company not found');
  const before = { plan: organization.plan, status: planService.subscriptionOf(organization).status };
  if (action === 'comp') await planService.compPlan(organization._id);
  else if (action === 'trial') await planService.startTrial(organization._id, days);
  else await planService.setPlan(organization._id, plan);
  await audit(req, {
    organizationId: organization._id, action: `platform.${action}`, entityType: 'Organization', entityId: organization._id,
    changes: { before, ...(action === 'trial' && { days }), ...(action === 'plan' && { plan }), by: req.user.email },
  });
  logger.info(`Platform admin ${req.user._id}: ${action} for organization ${organization._id}`);
  const [row] = await rowsFor([await Organization.findById(organization._id).select('name plan subscription deletion createdAt').lean()], new Date());
  return row;
}

// --- going live --------------------------------------------------------------------------------
// The tasks of docs/GO_LIVE_CHECKLIST.md, and whether this server has what each needs: done true
// (set), false (missing) or null (not visible from here — check by hand). Never a value.
function checklist() {
  const set = (...values) => values.every(Boolean);
  const httpsDomain = /^https:\/\//.test(env.publicUrl);
  const ownDomain = httpsDomain && !/\.onrender\.com$/i.test(new URL(env.publicUrl).hostname);
  const billingLive = env.billing.provider === 'razorpay' && set(env.billing.razorpay.keyId, env.billing.razorpay.keySecret, env.billing.razorpay.webhookSecret);
  const items = [
    { key: 'server', title: 'Server settings on Render (production)', done: env.isProduction && httpsDomain && set(env.dataEncryptionKey), guide: 'docs/RENDER_SETUP.md', without: 'Development defaults; secrets encrypted with the old key.' },
    { key: 'domain', title: 'Your own domain with HTTPS', done: ownDomain, guide: 'docs/DEPLOYMENT.md', without: 'Customers see an onrender.com address; Google and Meta need the final address in their settings.' },
    { key: 'database', title: 'MongoDB Atlas on a paid tier, with backups', done: null, guide: 'docs/DEPLOYMENT.md', without: 'The free tier stops growing at 512 MB and has no backups.' },
    { key: 'backups', title: 'Weekly backup copy (R2)', done: set(env.storage.r2.backupBucket), guide: 'docs/FOUNDATION_SETUP_STEPS.md', without: 'No weekly copy of the database outside Atlas.' },
    { key: 'files', title: 'Files on Cloudflare R2', done: env.storage.driver === 'r2', guide: 'docs/FOUNDATION_SETUP_STEPS.md', without: 'Files stay on one server\'s disk: a second server cannot run.' },
    { key: 'errors', title: 'Error reports (Sentry)', done: set(env.sentry.dsn), guide: 'docs/FOUNDATION_SETUP_STEPS.md', without: 'Errors are only in the server log.' },
    { key: 'google', title: 'Google sign-in for your domain', done: set(env.googleClientId, env.googleClientSecret), guide: 'docs/DEPLOYMENT.md', without: 'Nobody can sign in; Gmail, Calendar and Drive cannot connect. Publish the consent screen (and get it verified) by hand.' },
    { key: 'meta', title: 'Meta app: business verification and App Review', done: set(env.meta.appId, env.meta.appSecret, env.meta.esConfigId, env.meta.webhookVerifyToken), guide: 'docs/WHATSAPP_SETUP.md', without: 'Companies cannot connect WhatsApp with the Meta popup. Verification and App Review are checked in Meta, not here.' },
    { key: 'social', title: 'Instagram and Messenger: Facebook Login configuration and App Review', done: set(env.meta.appId, env.meta.appSecret, env.meta.socialConfigId, env.meta.webhookVerifyToken), guide: 'docs/INSTAGRAM_MESSENGER_SETUP.md', without: 'Companies cannot connect a Facebook Page or an Instagram account (G8). App Review and the Human Agent feature are checked in Meta, not here.' },
    { key: 'billing', title: 'Razorpay Subscriptions for the plans (live keys and webhook)', done: billingLive && /^rzp_live_/.test(env.billing.razorpay.keyId), guide: 'docs/BILLING_SETUP.md', without: 'Companies cannot buy a plan online; trials end into "choose a plan".' },
    { key: 'seller', title: 'Your legal details on the plan invoices', done: set(env.billing.seller.name, env.billing.seller.gstin, env.billing.seller.address, env.billing.seller.email), guide: 'docs/BILLING_SETUP.md', without: 'The GST invoices to companies miss the seller\'s name, GSTIN or address.' },
    { key: 'payments', title: 'Payment links: each company\'s Razorpay or Cashfree live keys and webhooks', done: null, guide: 'docs/PAYMENTS_SETUP.md', without: 'Set by each company in Settings → Payments; their payment links stay in test mode until then.' },
    { key: 'email', title: 'Emails from your domain (Resend: SPF, DKIM, DMARC)', done: emailService.enabled(), guide: 'docs/EMAIL_SETUP.md', without: 'No invite, trial, payment, invoice, deletion or new-login emails (the bell still works).' },
    { key: 'sms', title: 'SMS backup codes (MSG91 with DLT)', done: env.sms.provider === 'msg91' && set(env.sms.msg91AuthKey, env.sms.msg91TemplateId), guide: 'docs/SMS_SETUP.md', without: 'Login codes go only on WhatsApp.' },
    { key: 'otp', title: 'WhatsApp login codes from the platform\'s number', done: env.otp.provider === 'whatsapp' && set(env.otp.phoneNumberId, env.otp.accessToken, env.otp.template), guide: 'docs/WHATSAPP_SETUP.md', without: '2-step verification by WhatsApp code is off.' },
    { key: 'ai', title: 'AI assistant: Anthropic key and monthly budget', done: set(env.ai.apiKey), guide: 'docs/AI_ASSISTANT.md', without: 'The AI assistant is not offered.' },
    { key: 'admins', title: 'Platform admins with 2-step login', done: env.platformAdminEmails.length > 0, guide: 'docs/GO_LIVE_CHECKLIST.md', without: 'Nobody can open this page.' },
  ];
  // The server's own warnings name keys only (config/env.js), never values.
  return { items, done: items.filter((i) => i.done === true).length, total: items.length, warnings: env.warnings };
}

module.exports = { status, requireAdmin, unlock, lock, overview, companies, act, checklist, healthOf, UNLOCK_MS };
