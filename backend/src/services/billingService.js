const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const BillingPlan = require('../models/BillingPlan');
const BillingInvoice = require('../models/BillingInvoice');
const InboundEvent = require('../models/InboundEvent');
const Workflow = require('../models/Workflow');
const env = require('../config/env');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { nextSequence } = require('../utils/counter');
const { financialYear, formatRupees } = require('../utils/money');
const { stateCodeFromGstin } = require('../utils/gstin');
const { stateName } = require('../constants/gst');
const { PLANS, PLAN_KEYS, PLAN_GST_PCT } = require('../constants/plans');
const razorpay = require('../integrations/billing/razorpay');
const mock = require('../integrations/billing/mock');
const notificationService = require('./notificationService');
const planService = require('./planService');

// Paying for the CRM plan (Phase 10B, D50): Razorpay Subscriptions on the platform's own
// account (or the test gateway in development). Choosing a plan opens Razorpay's page; its
// webhooks (and a check every 6 hours, for a CRM without a public address) move the
// organization's subscription: active, payment due (Razorpay retries), halted (locked), cancelled
// (works until the paid month ends). Each monthly charge gets a GST tax invoice from the
// platform. Owners and admins hear about it under the bell.
const JOBS = { WEBHOOK: 'billing.webhook', SYNC: 'billing.sync', TRIAL: 'billing.trial' };
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PLATFORM_ID = new mongoose.Types.ObjectId('000000000000000000000000'); // the platform's own counters
const PLAN_LINK = 'Settings.html?tab=plan';
// Razorpay's subscription status → ours (constants/plans.js SUBSCRIPTION_STATUSES).
const STATUS_OF = { authenticated: 'active', active: 'active', pending: 'past_due', halted: 'halted', paused: 'halted', cancelled: 'cancelled', completed: 'expired', expired: 'expired' };
const FINAL = ['cancelled', 'completed', 'expired'];

const providerName = () => env.billing.provider;
function gateway() {
  if (env.billing.provider === 'razorpay') return razorpay;
  if (env.billing.provider === 'mock') return mock;
  return null;
}
const keys = () => env.billing.razorpay;
const keyId = () => (env.billing.provider === 'razorpay' ? keys().keyId : '');
const enabled = () => (env.billing.provider === 'mock'
  || (env.billing.provider === 'razorpay' && Boolean(keys().keyId && keys().keySecret && keys().webhookSecret)));

// What the Plan & usage page needs to know about paying online.
function publicStatus() {
  return {
    enabled: enabled(),
    provider: enabled() ? providerName() : null,
    test: env.billing.provider === 'mock' || /^rzp_test_/.test(keyId()),
    contactEmail: env.billing.seller.email || '',
  };
}

function offMessage() {
  const email = env.billing.seller.email;
  return `Paying for a plan online is not switched on yet. ${email ? `Write to ${email}` : 'Contact support'} to change your plan.`;
}

const managersOf = async (organizationId) => (await OrganizationMember.find({ organizationId, status: 'active', role: { $in: ['owner', 'admin'] } }).select('_id')).map((m) => m._id);
async function tellManagers(organizationId, title, body) {
  try {
    await notificationService.notify(organizationId, await managersOf(organizationId), { title, body, link: PLAN_LINK, source: 'billing' });
  } catch (error) {
    logger.error(`Billing note for ${organizationId} failed: ${error.message}`);
  }
}

// --- plans at the gateway ----------------------------------------------------------------------
const chargeOf = (planKey) => planService.serializePlan(planKey).totalPaise; // per month, GST included

async function providerPlanFor(planKey) {
  const filter = { provider: providerName(), keyId: keyId(), planKey, amountPaise: chargeOf(planKey) };
  const known = await BillingPlan.findOne(filter);
  if (known) return known.providerPlanId;
  const plan = PLANS[planKey];
  const made = await gateway().createPlan(keys(), {
    name: `YELLOW CRM ${plan.name}`,
    amountPaise: filter.amountPaise,
    description: `${plan.name} plan: ${formatRupees(plan.pricePaise)} + ${PLAN_GST_PCT}% GST a month`,
    notes: { planKey },
  });
  try {
    await BillingPlan.create({ ...filter, providerPlanId: made.id });
    return made.id;
  } catch (error) {
    if (error.code !== 11000) throw error;
    return (await BillingPlan.findOne(filter)).providerPlanId; // made at the same moment
  }
}

async function planKeyOf(providerPlanId) {
  if (!providerPlanId) return null;
  return (await BillingPlan.findOne({ provider: providerName(), providerPlanId }))?.planKey || null;
}

// --- choosing, changing and cancelling (owners and admins) ---------------------------------------
async function loadOrganization(organizationId) {
  const organization = await Organization.findById(organizationId);
  if (!organization) throw httpError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
  return organization;
}

const isPaying = (organization) => ['authenticated', 'active', 'pending'].includes(organization.subscription?.gatewayStatus);

// POST /billing/checkout { plan } → { checkoutUrl } (pay on the gateway's page) or { changed, when }.
async function checkout(req, { plan: planKey }) {
  if (!enabled()) throw httpError(409, 'BILLING_OFF', offMessage());
  const organization = await loadOrganization(req.tenant.organizationId);
  const sub = organization.subscription || {};
  const gw = gateway();

  if (sub.providerSubscriptionId && isPaying(organization)) {
    if (organization.plan === planKey && !sub.pendingPlan) throw httpError(409, 'SAME_PLAN', `You are already on the ${PLANS[planKey].name} plan.`);
    // Upgrades start now (Razorpay charges the difference its own way); downgrades next month.
    const when = PLANS[planKey].pricePaise > PLANS[organization.plan].pricePaise ? 'now' : 'cycle_end';
    try {
      await gw.changePlan(keys(), sub.providerSubscriptionId, { planId: await providerPlanFor(planKey), when });
    } catch (error) {
      if (!error.statusCode || error.statusCode >= 500) throw error;
      throw httpError(409, 'PLAN_CHANGE_REFUSED', `${error.message} Plans paid by UPI or e-mandate cannot be switched: cancel this plan and choose the new one when the paid month ends.`);
    }
    if (when === 'now') {
      await Organization.updateOne({ _id: organization._id }, { $unset: { 'subscription.pendingPlan': 1 } });
      await applyPlan(organization, planKey);
    } else {
      await Organization.updateOne({ _id: organization._id }, { $set: { 'subscription.pendingPlan': planKey } });
    }
    await audit(req, { action: 'billing.plan_changed', entityType: 'Organization', entityId: organization._id, changes: { from: organization.plan, to: planKey, when } });
    return { changed: true, when, plan: planKey };
  }

  // A new subscription. During the trial the first charge waits for its end (the rest of the
  // trial stays free); otherwise it is charged when the customer authorises.
  const state = planService.subscriptionOf(organization);
  const startAt = state.status === 'trialing' && state.trialEndsAt - Date.now() > DAY_MS ? state.trialEndsAt : null;
  if (sub.providerSubscriptionId && sub.gatewayStatus === 'created') {
    await gw.cancelSubscription(keys(), sub.providerSubscriptionId, { atCycleEnd: false }).catch(() => {}); // the unpaid one before
  }
  const created = await gw.createSubscription(keys(), {
    planId: await providerPlanFor(planKey),
    startAt,
    notes: { organizationId: String(organization._id), planKey },
  });
  await Organization.updateOne({ _id: organization._id }, {
    $set: {
      'subscription.provider': providerName(),
      'subscription.providerSubscriptionId': created.id,
      'subscription.gatewayStatus': created.status,
      'subscription.checkoutUrl': created.shortUrl,
      'subscription.pendingPlan': planKey,
    },
  });
  await audit(req, { action: 'billing.checkout', entityType: 'Organization', entityId: organization._id, changes: { plan: planKey, startAt } });
  return { checkoutUrl: created.shortUrl, startsAt: startAt };
}

// POST /billing/subscription/cancel — at the end of the paid month (at once if nothing was charged yet).
async function cancel(req) {
  if (!enabled()) throw httpError(409, 'BILLING_OFF', offMessage());
  const organization = await loadOrganization(req.tenant.organizationId);
  const sub = organization.subscription || {};
  if (!sub.providerSubscriptionId || !isPaying(organization)) throw httpError(409, 'NOT_SUBSCRIBED', 'There is no paid plan to cancel.');
  const atCycleEnd = sub.gatewayStatus === 'active';
  const result = await gateway().cancelSubscription(keys(), sub.providerSubscriptionId, { atCycleEnd });
  if (atCycleEnd) await Organization.updateOne({ _id: organization._id }, { $set: { 'subscription.cancelAtPeriodEnd': true } });
  else await applySubscription(organization._id, result);
  await audit(req, { action: 'billing.cancelled', entityType: 'Organization', entityId: organization._id, changes: { atCycleEnd } });
  return planService.summary(req);
}

// --- what the gateway says ---------------------------------------------------------------------
// Moves the organization to the gateway's state of its subscription. Events of an older
// subscription (an abandoned checkout) are ignored unless that one got paid instead.
async function applySubscription(organizationId, gsub) {
  const organization = await Organization.findById(organizationId);
  if (!organization || !gsub?.id) return null;
  const sub = organization.subscription || {};
  const ours = sub.providerSubscriptionId === gsub.id;
  const adopt = !ours && ['authenticated', 'active'].includes(gsub.status) && !isPaying(organization);
  if (!ours && !adopt) {
    if (['authenticated', 'active'].includes(gsub.status)) logger.warn(`Billing: organization ${organizationId} has a second paying subscription ${gsub.id}`);
    return null;
  }
  const set = { 'subscription.gatewayStatus': gsub.status, 'subscription.providerSubscriptionId': gsub.id, 'subscription.provider': providerName() };
  const unset = {};
  const status = STATUS_OF[gsub.status];
  if (!status) {
    await Organization.updateOne({ _id: organizationId }, { $set: set });
    return organization;
  }
  set['subscription.status'] = status;
  if (status !== sub.status) set['subscription.since'] = new Date();
  if (gsub.currentStart) set['subscription.currentPeriodStart'] = gsub.currentStart;
  const periodEnd = gsub.currentEnd || (gsub.status === 'authenticated' ? gsub.chargeAt || gsub.startAt : null);
  if (periodEnd) set['subscription.currentPeriodEnd'] = periodEnd;
  if (['active', 'cancelled', 'halted', 'expired'].includes(status)) unset['subscription.checkoutUrl'] = 1;
  if (status !== 'active') unset['subscription.cancelAtPeriodEnd'] = 1;
  const planKey = (await planKeyOf(gsub.planId)) || sub.pendingPlan || organization.plan;
  if (sub.pendingPlan && (sub.pendingPlan === planKey || !gsub.hasScheduledChanges)) unset['subscription.pendingPlan'] = 1;
  await Organization.updateOne({ _id: organizationId }, { $set: set, ...(Object.keys(unset).length && { $unset: unset }) });
  if (PLAN_KEYS.includes(planKey) && planKey !== organization.plan) await applyPlan(organization, planKey);

  if (status !== sub.status || !ours) {
    const name = PLANS[planKey]?.name || '';
    const notes = {
      active: [`Your ${name} plan is active`, gsub.status === 'authenticated' && periodEnd ? `The first payment is on ${periodEnd.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}.` : 'Thank you! The invoice is in Settings → Plan & usage.'],
      past_due: ['The payment for your plan did not go through', 'Razorpay will try again. Check the card or UPI mandate to keep your plan.'],
      halted: ['Your plan has stopped', 'The payments failed. Your data is safe and chats keep working; choose a plan again to add things.'],
      cancelled: ['Your plan is cancelled', periodEnd ? `It works until ${periodEnd.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}.` : ''],
      expired: ['Your plan has ended', 'Choose a plan to add contacts, quotations, broadcasts and teammates again.'],
    }[status];
    if (notes) await tellManagers(organizationId, notes[0], notes[1]);
  }
  return organization;
}

// A new plan takes effect: features the plan does not have stop (workflows are paused, not
// deleted); counted things above the new limits stay, but no more can be added (D49).
async function applyPlan(organization, planKey) {
  await Organization.updateOne({ _id: organization._id }, { $set: { plan: planKey } });
  if (!PLANS[planKey].advancedAutomation) {
    const { modifiedCount } = await Workflow.updateMany({ organizationId: organization._id, status: 'Active' }, { $set: { status: 'Paused' } });
    if (modifiedCount) await tellManagers(organization._id, `${modifiedCount} workflow${modifiedCount === 1 ? ' was' : 's were'} paused`, `Automation workflows come with the Growth plan and above (now on ${PLANS[planKey].name}).`);
  }
  logger.info(`Billing: organization ${organization._id} plan ${organization.plan} → ${planKey}`);
}

// --- GST invoices ------------------------------------------------------------------------------
function sellerParty() {
  const { name, gstin, address, email } = env.billing.seller;
  const stateCode = stateCodeFromGstin(gstin) || '';
  return { name: name || 'YELLOW CRM', gstin, address, stateCode, state: stateName(stateCode), email };
}
function buyerParty(organization) {
  const gstin = String(organization.gstin || organization.get('gst') || '').toUpperCase();
  const stateCode = organization.stateCode || stateCodeFromGstin(gstin) || '';
  const address = [organization.address, organization.city, organization.state, organization.postalCode].filter(Boolean).join(', ');
  return { name: organization.name, gstin, address, stateCode, state: stateName(stateCode), email: organization.email || '' };
}

// Gap-free numbers: the invoice is saved first (one per payment), then numbered.
async function numberInvoice(invoice) {
  const fy = financialYear(invoice.issuedAt);
  const seq = await nextSequence(PLATFORM_ID, `billing-invoice:${fy}`);
  invoice.number = `${env.billing.invoicePrefix}/${fy}/${String(seq).padStart(4, '0')}`;
  await BillingInvoice.updateOne({ _id: invoice._id }, { $set: { number: invoice.number } });
  return invoice;
}

// One paid month → one GST invoice (the amount paid includes 18% GST).
async function recordCharge(organizationId, { subscriptionId, planId, payment, periodStart, periodEnd }) {
  const provider = providerName();
  if (await BillingInvoice.exists({ provider, providerPaymentId: payment.id })) return null;
  const organization = await Organization.findById(organizationId);
  if (!organization) return null;
  const planKey = (await planKeyOf(planId)) || organization.plan;
  const seller = sellerParty();
  const buyer = buyerParty(organization);
  const placeOfSupplyCode = buyer.stateCode || seller.stateCode;
  const totalPaise = payment.amountPaise;
  const taxablePaise = Math.round((totalPaise * 100) / (100 + PLAN_GST_PCT));
  const tax = totalPaise - taxablePaise;
  const intraState = Boolean(seller.stateCode) && placeOfSupplyCode === seller.stateCode;
  let invoice;
  try {
    invoice = await BillingInvoice.create({
      organizationId, number: `pending:${provider}:${payment.id}`, issuedAt: payment.paidAt || new Date(),
      planKey, planName: PLANS[planKey]?.name || planKey, periodStart, periodEnd, sac: env.billing.sac,
      seller, buyer, placeOfSupplyCode, taxablePaise,
      cgstPaise: intraState ? Math.floor(tax / 2) : 0, sgstPaise: intraState ? tax - Math.floor(tax / 2) : 0, igstPaise: intraState ? 0 : tax,
      totalPaise, provider, providerPaymentId: payment.id, providerInvoiceId: payment.invoiceId || '', providerSubscriptionId: subscriptionId,
    });
  } catch (error) {
    if (error.code === 11000) return null; // recorded by the webhook and the check at once
    throw error;
  }
  await numberInvoice(invoice);
  await tellManagers(organizationId, `Payment received: ${formatRupees(totalPaise)}`, `${invoice.planName} plan, invoice ${invoice.number}.`);
  return invoice;
}

// --- webhooks and checks -----------------------------------------------------------------------
async function storeEvent(provider, parsed, queue) {
  const organizationId = mongoose.isValidObjectId(parsed.subscription.notes?.organizationId) ? parsed.subscription.notes.organizationId : undefined;
  let event;
  try {
    event = await InboundEvent.create({ provider: `${provider}-billing`, eventId: parsed.eventId, kind: 'billing', organizationId, payload: parsed });
  } catch (error) {
    if (error.code === 11000) return false; // sent again
    throw error;
  }
  await queue.enqueue(JOBS.WEBHOOK, { eventId: String(event._id) }, { uniqueKey: `billing.webhook:${event._id}`, maxAttempts: 6 });
  return true;
}

// POST /api/v1/webhooks/billing/razorpay — signed with the platform's webhook secret.
async function receiveWebhook(rawBody, headers, queue = require('../jobs/queue')) {
  if (env.billing.provider !== 'razorpay' || !enabled()) return { status: 404 };
  if (!razorpay.verifyWebhook({ rawBody, headers, secret: keys().webhookSecret })) return { status: 401 };
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400 };
  }
  const parsed = razorpay.parseWebhook(payload, headers);
  if (!parsed) return { status: 200 };
  return { status: 200, queued: await storeEvent('razorpay', parsed, queue) };
}

async function organizationOfEvent(event, gsub) {
  if (event.organizationId) return event.organizationId;
  return (await Organization.findOne({ 'subscription.providerSubscriptionId': gsub.id }).select('_id'))?._id || null;
}

async function processWebhook({ eventId }) {
  const event = await InboundEvent.findOneAndUpdate({ _id: eventId }, { $inc: { attempts: 1 } }, { returnDocument: 'after' });
  if (!event || event.status === 'processed') return;
  const parsed = event.payload;
  const organizationId = await organizationOfEvent(event, parsed.subscription);
  if (!organizationId) {
    await InboundEvent.updateOne({ _id: event._id }, { status: 'ignored', processedAt: new Date() });
    return;
  }
  // Webhooks can come out of order: the subscription's state is read fresh from the gateway.
  let current = parsed.subscription;
  try {
    current = await gateway().fetchSubscription(keys(), parsed.subscription.id);
  } catch (error) {
    logger.warn(`Billing: reading subscription ${parsed.subscription.id} failed (${error.message}); using the event`);
  }
  await applySubscription(organizationId, current);
  if (parsed.event === 'subscription.charged' && parsed.payment) {
    await recordCharge(organizationId, {
      subscriptionId: parsed.subscription.id, planId: parsed.subscription.planId, payment: parsed.payment,
      periodStart: parsed.subscription.currentStart, periodEnd: parsed.subscription.currentEnd,
    });
  }
  await InboundEvent.updateOne({ _id: event._id }, { status: 'processed', processedAt: new Date() });
}

// Asks the gateway about one organization's subscription: its state and any paid month
// without an invoice yet (when webhooks cannot reach this CRM).
async function syncOrganization(organizationId) {
  const organization = await Organization.findById(organizationId);
  const id = organization?.subscription?.providerSubscriptionId;
  if (!id || !gateway() || !enabled() || organization.subscription.provider !== providerName()) return null;
  const gsub = await gateway().fetchSubscription(keys(), id);
  await applySubscription(organization._id, gsub);
  for (const paid of await gateway().paidInvoices(keys(), id)) {
    await recordCharge(organization._id, {
      subscriptionId: id, planId: gsub.planId,
      payment: { id: paid.paymentId, amountPaise: paid.amountPaise, paidAt: paid.paidAt, invoiceId: paid.invoiceId },
      periodStart: paid.periodStart, periodEnd: paid.periodEnd,
    });
  }
  return gsub;
}

// POST /billing/subscription/refresh — "Check now".
async function refresh(req) {
  if (!enabled()) throw httpError(409, 'BILLING_OFF', offMessage());
  await syncOrganization(req.tenant.organizationId);
  return planService.summary(req);
}

async function syncAll() {
  const organizations = await Organization.find({
    'subscription.providerSubscriptionId': { $exists: true },
    'subscription.gatewayStatus': { $nin: FINAL },
  }).select('_id').limit(1000);
  for (const { _id } of organizations) {
    try {
      await syncOrganization(_id);
    } catch (error) {
      logger.warn(`Billing check for organization ${_id} failed: ${error.message}`);
    }
  }
  // An invoice saved but not numbered (the server stopped in between) gets its number.
  for (const invoice of await BillingInvoice.find({ number: /^pending:/ }).limit(100)) await numberInvoice(invoice);
}

// Trial reminders under the bell: 7, 3 and 1 days before the end, and when it ends (once each).
const REMINDERS = ['7', '3', '1', 'ended'];
async function remindTrials(now = new Date()) {
  const trials = await Organization.find({ 'subscription.status': 'trialing', 'subscription.trialEndsAt': { $lte: new Date(now.getTime() + 7 * DAY_MS) } })
    .select('subscription plan');
  for (const organization of trials) {
    const sub = organization.subscription;
    if (isPaying(organization)) continue; // a plan is chosen: its first payment ends the trial
    const daysLeft = Math.ceil((sub.trialEndsAt - now) / DAY_MS);
    const level = daysLeft <= 0 ? 'ended' : daysLeft <= 1 ? '1' : daysLeft <= 3 ? '3' : '7';
    if (REMINDERS.indexOf(level) <= REMINDERS.indexOf(sub.remindedFor || '')) continue;
    const { modifiedCount } = await Organization.updateOne({ _id: organization._id, 'subscription.remindedFor': sub.remindedFor ?? null }, { $set: { 'subscription.remindedFor': level } });
    if (!modifiedCount) continue;
    if (level === 'ended') await tellManagers(organization._id, 'Your free trial has ended', 'Your data is safe and chats keep working. Choose a plan to add contacts, quotations, broadcasts and teammates again.');
    else await tellManagers(organization._id, `Your free trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`, 'Choose a plan in Settings → Plan & usage to keep everything running.');
  }
}

// --- invoices for the page -------------------------------------------------------------------
function serializeInvoice(invoice) {
  return {
    id: invoice._id, number: invoice.number, issuedAt: invoice.issuedAt, planName: invoice.planName,
    periodStart: invoice.periodStart || null, periodEnd: invoice.periodEnd || null,
    taxablePaise: invoice.taxablePaise, gstPaise: invoice.cgstPaise + invoice.sgstPaise + invoice.igstPaise, totalPaise: invoice.totalPaise,
  };
}

async function listInvoices(req) {
  const invoices = await BillingInvoice.find({ organizationId: req.tenant.organizationId }).sort({ issuedAt: -1 }).limit(100);
  return invoices.map(serializeInvoice);
}

async function invoicePdf(req, id) {
  const invoice = mongoose.isValidObjectId(id) ? await BillingInvoice.findOne({ _id: id, organizationId: req.tenant.organizationId }) : null;
  if (!invoice) throw httpError(404, 'NOT_FOUND', 'Invoice not found');
  const buffer = await require('./billingInvoicePdf').render(invoice); // eslint-disable-line global-require
  return { buffer, fileName: `${invoice.number.replace(/\//g, '-')}.pdf` };
}

// --- the test gateway's page ------------------------------------------------------------------
async function testSubscription(id) {
  if (env.billing.provider !== 'mock') return null;
  const sub = mock.get(id);
  if (!sub) return null;
  const planKey = await planKeyOf(sub.planId);
  return { ...sub, planName: PLANS[planKey]?.name || '', amountPaise: mock.amountOf(sub.planId) };
}

async function actOnTest(id, action, queue = require('../jobs/queue')) {
  if (env.billing.provider !== 'mock') throw httpError(404, 'NOT_FOUND', 'Not found');
  for (const parsed of mock.act(id, action)) await storeEvent('mock', parsed, queue);
}

function register(queue) {
  queue.define(JOBS.WEBHOOK, processWebhook, { maxAttempts: 6 });
  queue.define(JOBS.SYNC, () => syncAll(), { maxAttempts: 2 });
  queue.define(JOBS.TRIAL, () => remindTrials(), { maxAttempts: 2 });
  queue.every(JOBS.SYNC, SYNC_EVERY_MS).catch((error) => logger.error(`Scheduling ${JOBS.SYNC} failed: ${error.message}`));
  queue.every(JOBS.TRIAL, SYNC_EVERY_MS).catch((error) => logger.error(`Scheduling ${JOBS.TRIAL} failed: ${error.message}`));
}

module.exports = {
  JOBS, publicStatus, checkout, cancel, refresh, receiveWebhook, processWebhook, applySubscription, recordCharge,
  syncOrganization, syncAll, remindTrials, listInvoices, invoicePdf, serializeInvoice, testSubscription, actOnTest, register, PLATFORM_ID,
};
