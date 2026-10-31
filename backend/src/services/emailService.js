const EmailDelivery = require('../models/EmailDelivery');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const BillingInvoice = require('../models/BillingInvoice');
const env = require('../config/env');
const logger = require('../config/logger');
const queue = require('../jobs/queue');
const { encrypt, decrypt } = require('../utils/secretBox');
const templates = require('../views/emails');

// The platform's own emails (D104), through Resend's API (no SDK: one fetch). Each email is an
// EmailDelivery first, then a job (email.send) that renders it in the person's language and sends
// it — again on Resend's rate limit and outages, with the same Idempotency-Key so a retry never
// sends twice (Resend keeps the key 24 hours; API and errors read 2026-10-30). Without
// RESEND_API_KEY and EMAIL_FROM nothing is sent: the email is "skipped" and everything else (the
// bell, the invite link) works as before. Sending never fails what asked for it.
const JOB = 'email.send';
const MAX_ATTEMPTS = 6;
const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 15 * 1000;
const NOT_SET = 'RESEND_API_KEY or EMAIL_FROM is not set.';
// Resend's errors worth another try: rate limit, a busy resource, its own outages. Quota errors and
// a reused key with another body are not (they need a change first).
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const NO_RETRY_NAMES = new Set(['daily_quota_exceeded', 'monthly_quota_exceeded', 'invalid_idempotent_request']);

const enabled = () => Boolean(env.email.resendApiKey && env.email.from);
const languageOf = (user) => (user?.preferences?.language === 'hi' ? 'hi' : 'en');

// Queues one email. secrets (e.g. an invite link) are stored encrypted and removed once sent.
// → the delivery, or null (sent before, no address, or it could not be queued).
async function queueEmail(kind, { to, organizationId, userId, language = 'en', data = {}, secrets = {}, dedupeKey }) {
  if (!to) return null;
  try {
    const on = enabled();
    const sealed = on ? Object.fromEntries(Object.entries(secrets).map(([key, value]) => [`${key}Enc`, encrypt(String(value))])) : {};
    let delivery;
    try {
      delivery = await EmailDelivery.create({
        organizationId, userId, kind, to, language, data: { ...data, ...sealed }, dedupeKey,
        ...(!on && { status: 'skipped', error: NOT_SET }),
      });
    } catch (error) {
      if (error.code === 11000) return null; // this email went (or was queued) before
      throw error;
    }
    if (on) await queue.enqueue(JOB, { id: String(delivery._id) }, { uniqueKey: `email:${delivery._id}`, organizationId, maxAttempts: MAX_ATTEMPTS });
    return delivery;
  } catch (error) {
    logger.error(`Email ${kind} could not be queued: ${error.message}`);
    return null;
  }
}

// --- who gets what -----------------------------------------------------------------------------
const nameOf = async (organizationId) => (await Organization.findById(organizationId).select('name').lean())?.name || '';

// Every active owner and admin of a company, each in their own language. dedupe: one per person.
async function toManagers(organizationId, kind, data, { dedupe } = {}) {
  const members = await OrganizationMember.find({ organizationId, status: 'active', role: { $in: ['owner', 'admin'] } })
    .select('userId').populate({ path: 'userId', select: 'email preferences disabledAt' });
  const organizationName = data.organizationName ?? await nameOf(organizationId);
  const queued = [];
  for (const { userId: user } of members) {
    if (!user?.email || user.disabledAt) continue;
    queued.push(await queueEmail(kind, {
      to: user.email, organizationId, userId: user._id, language: languageOf(user),
      data: { ...data, organizationName }, dedupeKey: dedupe ? `${dedupe}:${user._id}` : undefined,
    }));
  }
  return queued.filter(Boolean);
}

// A team invite (created or sent again): to the invited address, in the inviter's language.
async function inviteEmail({ invite, link, inviter }) {
  return queueEmail('invite', {
    to: invite.email, organizationId: invite.organizationId, language: languageOf(inviter),
    data: { organizationName: await nameOf(invite.organizationId), inviterName: inviter?.name || inviter?.email || '', role: invite.role, expiresAt: invite.expiresAt },
    secrets: { link }, dedupeKey: `invite:${invite._id}:${invite.tokenHash.slice(0, 16)}`,
  });
}

// Trial reminders: level '7' | '3' | '1' | 'ended' (once each, billingService.remindTrials).
function trialEmail(organizationId, { level, daysLeft, trialEndsAt }) {
  return level === 'ended'
    ? toManagers(organizationId, 'trial_ended', { trialEndsAt }, { dedupe: `trial:${organizationId}:ended:${new Date(trialEndsAt).getTime()}` })
    : toManagers(organizationId, 'trial_reminder', { daysLeft, trialEndsAt }, { dedupe: `trial:${organizationId}:${level}:${new Date(trialEndsAt).getTime()}` });
}

// A failed payment: 'retrying' (Razorpay tries again) or 'stopped' (the plan halted). At most
// one of each a day.
function paymentEmail(organizationId, { stage, planName }) {
  const day = new Date().toISOString().slice(0, 10);
  return toManagers(organizationId, 'payment_failed', { stage, planName }, { dedupe: `payment:${organizationId}:${stage}:${day}` });
}

// The plan's GST invoice after a payment, with its PDF.
function invoiceEmail(invoice) {
  return toManagers(invoice.organizationId, 'plan_invoice', {
    invoiceId: String(invoice._id), number: invoice.number, planName: invoice.planName, totalPaise: invoice.totalPaise,
    periodStart: invoice.periodStart || null, periodEnd: invoice.periodEnd || null,
  }, { dedupe: `invoice:${invoice._id}` });
}

// The company is set to be deleted (when an owner asks), and the day before.
function deletionEmail(organizationId, { scheduledFor, requestedBy = '', tomorrow = false }) {
  const kind = tomorrow ? 'deletion_tomorrow' : 'deletion_scheduled';
  return toManagers(organizationId, kind, { scheduledFor, requestedBy }, { dedupe: `${kind}:${organizationId}:${new Date(scheduledFor).getTime()}` });
}

// A new login, unless the person switched these emails off.
async function loginEmail(user, { organizationId, device, at = new Date() }) {
  if (user.loginAlertEmails === false) return null;
  return queueEmail('login_alert', { to: user.email, organizationId, userId: user._id, language: languageOf(user), data: { device, at } });
}

// --- sending ------------------------------------------------------------------------------------
function openSecrets(data) {
  const open = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (key.endsWith('Enc')) open[key.slice(0, -3)] = decrypt(value);
    else open[key] = value;
  }
  return open;
}

async function attachmentsOf(delivery, data) {
  if (delivery.kind !== 'plan_invoice' || !data.invoiceId) return [];
  const invoice = await BillingInvoice.findById(data.invoiceId);
  if (!invoice) return [];
  const buffer = await require('./billingInvoicePdf').render(invoice); // eslint-disable-line global-require
  return [{ filename: `${invoice.number.replace(/\//g, '-')}.pdf`, content: buffer.toString('base64') }];
}

const secretKeys = (delivery) => Object.keys(delivery.data || {}).filter((key) => key.endsWith('Enc'));
async function finish(delivery, status, set = {}) {
  const unset = Object.fromEntries(secretKeys(delivery).map((key) => [`data.${key}`, 1]));
  await EmailDelivery.updateOne({ _id: delivery._id }, { $set: { status, ...set }, ...(Object.keys(unset).length && { $unset: unset }) });
}

// Another try later (the queue's backoff), or failed after the last one.
async function retryOrFail(delivery, attempt, reason) {
  if (attempt < MAX_ATTEMPTS) {
    await EmailDelivery.updateOne({ _id: delivery._id }, { $set: { attempts: attempt, error: reason } });
    throw new Error(reason);
  }
  await finish(delivery, 'failed', { attempts: attempt, error: reason });
  logger.warn(`Email ${delivery._id} (${delivery.kind}) failed after ${attempt} tries: ${reason}`);
  return 'failed';
}

// The job: renders and sends one queued email. → 'sent' | 'failed' | 'skipped' | 'done'
async function sendDue({ id }, job) {
  const delivery = await EmailDelivery.findById(id);
  if (!delivery || delivery.status !== 'queued') return 'done';
  if (!enabled()) {
    await finish(delivery, 'skipped', { error: NOT_SET });
    return 'skipped';
  }
  const attempt = job?.attempts || delivery.attempts + 1;
  let message;
  try {
    const data = openSecrets(delivery.data);
    message = { ...templates.render(delivery.kind, delivery.language, { ...data, to: delivery.to }), attachments: await attachmentsOf(delivery, data) };
  } catch (error) {
    await finish(delivery, 'failed', { attempts: attempt, error: `Could not be written: ${error.message}` });
    return 'failed';
  }
  let response;
  let body;
  try {
    response = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.email.resendApiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `crm-email-${delivery._id}` },
      body: JSON.stringify({
        from: env.email.from, to: [delivery.to], subject: message.subject, html: message.html, text: message.text,
        ...(message.attachments.length && { attachments: message.attachments }),
        tags: [{ name: 'kind', value: delivery.kind }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body = await response.json().catch(() => ({}));
  } catch (error) {
    return retryOrFail(delivery, attempt, `Resend did not answer: ${error.message}`);
  }
  if (response.ok && body?.id) {
    await finish(delivery, 'sent', { attempts: attempt, providerId: String(body.id), subject: message.subject, sentAt: new Date(), error: '' });
    return 'sent';
  }
  const reason = `${response.status} ${body?.name || ''}: ${body?.message || 'no message'}`.replace(/\s+/g, ' ').slice(0, 500);
  if (RETRY_STATUS.has(response.status) && !NO_RETRY_NAMES.has(body?.name)) return retryOrFail(delivery, attempt, reason);
  await finish(delivery, 'failed', { attempts: attempt, subject: message.subject, error: reason });
  logger.warn(`Email ${delivery._id} (${delivery.kind}) refused by Resend: ${reason}`);
  return 'failed';
}

function register(jobs) {
  jobs.define(JOB, sendDue, { maxAttempts: MAX_ATTEMPTS });
}

// For the platform admin page: the last 30 days by status and kind, and the latest ones.
async function stats({ limit = 50, status } = {}) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [byStatus, recent] = await Promise.all([
    EmailDelivery.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: { status: '$status', kind: '$kind' }, count: { $sum: 1 } } }]),
    EmailDelivery.find(status ? { status } : {}).sort({ createdAt: -1 }).limit(limit).select('kind to language status attempts error subject sentAt createdAt organizationId').lean(),
  ]);
  const totals = { queued: 0, sent: 0, failed: 0, skipped: 0 };
  const kinds = {};
  for (const row of byStatus) {
    totals[row._id.status] = (totals[row._id.status] || 0) + row.count;
    kinds[row._id.kind] = { ...(kinds[row._id.kind] || {}), [row._id.status]: row.count };
  }
  return {
    enabled: enabled(),
    totals,
    kinds,
    recent: recent.map((d) => ({
      id: d._id, kind: d.kind, to: d.to, language: d.language, status: d.status, attempts: d.attempts, error: d.error,
      subject: d.subject, sentAt: d.sentAt || null, createdAt: d.createdAt, organizationId: d.organizationId || null,
    })),
  };
}

module.exports = {
  JOB, MAX_ATTEMPTS, enabled, languageOf, queueEmail, toManagers, inviteEmail, trialEmail, paymentEmail, invoiceEmail, deletionEmail, loginEmail,
  sendDue, register, stats,
};
