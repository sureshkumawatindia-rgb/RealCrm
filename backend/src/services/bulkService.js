const BulkJob = require('../models/BulkJob');
const Contact = require('../models/Contact');
const OrganizationMember = require('../models/OrganizationMember');
const User = require('../models/User');
const httpError = require('../utils/httpError');
const logger = require('../config/logger');
const { audit } = require('../utils/audit');
const { can, isManager } = require('../constants/permissions');
const leadService = require('./leadService');
const contactService = require('./contactService');
const sequenceService = require('./sequenceService');
const smsService = require('./smsService');
const phoneVisibility = require('./phoneVisibility');
const { loadContext } = require('./automation/context');
const { resolveVariables } = require('./automation/actions');

// Bulk actions on leads (Phase 8B, D89) and, since D100, on customers, from Boards and the Leads
// and Customers lists. Every row goes through the same service as one change by hand
// (visibility, owner rules, versions, plan limits, consent), so a row the member may not change
// fails on its own and is listed; the rest are done. Private numbers (D61) are always left alone.
// Up to 200 rows are done in the request; up to 5,000 in a "bulk.run" job (BulkJob) whose
// progress the page follows. A stage change starts workflows only with "Run automations too".
const MAX_IDS = 5000;
const INLINE_MAX = 200;
const JOB = 'bulk.run';
const KEEP_FAILED = 500;

const privateRow = () => httpError(409, 'PRIVATE', 'A private number: bulk actions leave it alone.');
const sameTag = (a, b) => a.toLowerCase() === b.toLowerCase();

// Adds or removes a tag through the customer's own service (history, webhooks); a tag it
// already has (any capitals), or does not have, is fine.
async function retag(req, contactId, tag, add, { skipVisibility = false } = {}) {
  const contact = await Contact.findOne({ _id: contactId, organizationId: req.tenant.organizationId }).select('tags');
  if (!contact) throw httpError(404, 'NOT_FOUND', 'The customer was removed.');
  const tags = contact.tags || [];
  const has = tags.some((t) => sameTag(t, tag));
  if (add === has) return;
  await contactService.updateContact(req, contactId, { tags: add ? [...tags, tag] : tags.filter((t) => !sameTag(t, tag)) }, { skipVisibility });
}

const LEAD_ACTIONS = {
  assign: (req, id, p) => leadService.update(req, id, { ownerId: p.ownerId || null }),
  stage: (req, id, p) => leadService.changeStage(req, id, { stage: p.stage, ...(p.lostReason && { lostReason: p.lostReason }) }),
  followUp: (req, id, p) => leadService.update(req, id, { followUpAt: p.at || null }),
  // The lead's customer gets (or loses) the tag; seeing the lead is enough, as on the lead's form.
  tag: (req, id, p, key, lead) => retag(req, lead.contactId, p.tag, true, { skipVisibility: true }),
  untag: (req, id, p, key, lead) => retag(req, lead.contactId, p.tag, false, { skipVisibility: true }),
  sequence: (req, id, p) => sequenceService.enroll(req, p.sequenceId, { leadId: id }),
  async sms(req, id, p, key, lead) {
    const organizationId = req.tenant.organizationId;
    const ctx = await loadContext({ organizationId, subject: { leadId: lead._id } });
    if (!ctx.contact) throw httpError(404, 'NOT_FOUND', 'The customer was removed.');
    if (ctx.contact.private) throw privateRow();
    return smsService.sendFromStep({
      organizationId, contact: ctx.contact, lead, templateKey: p.template, valuesFor: () => resolveVariables({ body: p.variables || {} }, ctx).body,
      source: 'bulk', memberId: req.member._id, idempotencyKey: key ? `bulk:${key}:${id}` : undefined,
    });
  },
  delete: (req, id) => leadService.remove(req, id),
};

const CONTACT_ACTIONS = {
  assign: (req, id, p) => contactService.updateContact(req, id, { ownerId: p.ownerId || null }),
  tag: (req, id, p) => retag(req, id, p.tag, true),
  untag: (req, id, p) => retag(req, id, p.tag, false),
  sequence: (req, id, p) => sequenceService.enroll(req, p.sequenceId, { contactId: id }),
  delete: (req, id) => contactService.remove(req, id),
};

const OBJECTS = {
  lead: { entityType: 'Lead', findVisible: leadService.findVisible, actions: LEAD_ACTIONS },
  contact: { entityType: 'Contact', findVisible: contactService.findVisible, actions: CONTACT_ACTIONS },
};

// What an action needs beyond editing the rows (checked again when a job starts).
const canDelete = { lead: (m) => can(m, 'leads', 'delete') || can(m, 'deals', 'delete'), contact: (m) => can(m, 'customers', 'delete') };
function assertAllowed(member, object, action) {
  // Only they may change owners (access.ownerPatch); for anyone else it would do nothing.
  if (action === 'assign' && !isManager(member)) throw httpError(403, 'FORBIDDEN', 'Only owners and admins can give records to someone else.');
  if (action === 'sequence' && !can(member, 'automation', 'edit')) throw httpError(403, 'FORBIDDEN', 'Adding to a sequence needs Sales Automation.');
  if (action === 'sms' && !can(member, 'customers', 'edit')) throw httpError(403, 'FORBIDDEN', 'Sending SMS needs Customers (edit).');
  if (action === 'delete' && !canDelete[object](member)) throw httpError(403, 'FORBIDDEN', 'You may not delete these.');
}

// One row: seen by this member, not a private number, then the action.
async function runRow(req, object, action, id, params, key) {
  const def = OBJECTS[object];
  const doc = await def.findVisible(req, id);
  if (doc.private) throw privateRow();
  await def.actions[action](req, id, params, key, doc);
}

// Each row in turn. onProgress(state) after every row; a 4xx is that row's reason. In a job
// (lenient) anything else is too, so one bad row never stops the others.
async function runRows(req, object, { action, ids, params, key, start = 0, lenient = false, onProgress }) {
  const state = { position: start, done: 0, failed: [], reasons: {} };
  for (let i = start; i < ids.length; i += 1) {
    const id = String(ids[i]);
    try {
      await runRow(req, object, action, id, params, key);
      state.done += 1;
    } catch (error) {
      const known = error.statusCode && error.statusCode < 500;
      if (!known && !lenient) throw error;
      if (!known) logger.error(`Bulk ${object} ${action} on ${id} failed: ${error.message}`);
      const code = known ? error.code || 'ERROR' : 'ERROR';
      state.failed.push({ id, code, message: known ? error.message : 'Something went wrong with this one. Try it again on its own.' });
      state.reasons[code] = (state.reasons[code] || 0) + 1;
    }
    state.position = i + 1;
    if (onProgress) await onProgress(state);
  }
  return state;
}

const summary = (req, object, action, { total, done, failedCount, params }) => audit(req, {
  action: `${object}.bulk_${action}`, entityType: OBJECTS[object].entityType, changes: { total, done, failed: failedCount, params },
});

function serializeJob(job) {
  return {
    jobId: job._id, status: job.status, object: job.object, action: job.action, total: job.ids.length, position: job.position,
    done: job.done, failed: job.failed || [], failedCount: job.failedCount, reasons: job.reasons || {}, error: job.error || '',
    startedAt: job.startedAt || null, finishedAt: job.finishedAt || null, createdAt: job.createdAt,
  };
}

// POST /bulk/leads, /bulk/contacts { action, ids, params, runAutomations } → the report
// { status: "done", total, done, failed: [{ id, code, message }], reasons }, or for more than
// 200 rows the job ({ jobId, status: "queued", … }) to follow with GET /bulk/jobs/:id.
async function start(req, object, { action, ids, params = {}, runAutomations = false }, key, queue) {
  assertAllowed(req.member, object, action);
  const unique = [...new Set(ids.map(String))].slice(0, MAX_IDS);
  if (unique.length > INLINE_MAX) {
    const busy = await BulkJob.exists({ organizationId: req.tenant.organizationId, memberId: req.member._id, status: { $in: ['queued', 'running'] } });
    if (busy) throw httpError(409, 'BULK_BUSY', 'Your last bulk action is still running. Wait for it to finish, then try again.');
    const job = await BulkJob.create({ organizationId: req.tenant.organizationId, memberId: req.member._id, object, action, params, runAutomations, ids: unique });
    await (queue || require('../jobs/queue')).enqueue(JOB, { jobId: String(job._id) }, { uniqueKey: `bulk:${job._id}`, organizationId: req.tenant.organizationId, maxAttempts: 3 }); // eslint-disable-line global-require
    return serializeJob(job);
  }
  req.skipWorkflows = !runAutomations;
  const state = await runRows(req, object, { action, ids: unique, params, key });
  await summary(req, object, action, { total: unique.length, done: state.done, failedCount: state.failed.length, params });
  return { status: 'done', object, action, total: unique.length, done: state.done, failed: state.failed, failedCount: state.failed.length, reasons: state.reasons };
}

// The member who started a job, as a request (their permissions now, not when they started it).
async function memberReq(job) {
  const member = await OrganizationMember.findOne({ _id: job.memberId, organizationId: job.organizationId, status: 'active' });
  const user = member ? await User.findById(member.userId) : null;
  if (!member || !user || user.disabledAt) return null;
  return {
    user, member, tenant: { organizationId: member.organizationId, memberId: member._id, userId: user._id, role: member.role },
    maskPhones: await phoneVisibility.hidesPhonesFor(member), skipWorkflows: !job.runAutomations, id: `bulk:${job._id}`, ip: '', get: () => '',
  };
}

// The "bulk.run" job: carries on from `position`, saving the progress every 20 rows.
async function runJob({ jobId }) {
  const job = await BulkJob.findById(jobId);
  if (!job || job.status === 'done' || job.status === 'failed') return;
  const fail = (error) => BulkJob.updateOne({ _id: job._id }, { $set: { status: 'failed', error, finishedAt: new Date() } });
  const req = await memberReq(job);
  if (!req) return fail('The person who started it is no longer an active team member.');
  try {
    assertAllowed(req.member, job.object, job.action);
  } catch (error) {
    return fail(error.message);
  }
  await BulkJob.updateOne({ _id: job._id }, { $set: { status: 'running', ...(!job.startedAt && { startedAt: new Date() }) } });
  let saved = { done: 0, failed: 0 };
  const save = (state, extra = {}) => {
    const fresh = state.failed.slice(saved.failed);
    const set = { position: state.position, done: job.done + state.done, failedCount: job.failedCount + state.failed.length, ...extra };
    for (const [code, n] of Object.entries(state.reasons)) set[`reasons.${code}`] = (job.reasons?.[code] || 0) + n;
    saved = { done: state.done, failed: state.failed.length };
    return BulkJob.updateOne({ _id: job._id }, { $set: set, ...(fresh.length && { $push: { failed: { $each: fresh, $slice: KEEP_FAILED } } }) });
  };
  const state = await runRows(req, job.object, {
    action: job.action, ids: job.ids, params: job.params || {}, key: String(job._id), start: job.position, lenient: true,
    onProgress: (s) => (s.position % 20 === 0 ? save(s) : null),
  });
  await save(state, { status: 'done', finishedAt: new Date() });
  await summary(req, job.object, job.action, { total: job.ids.length, done: job.done + state.done, failedCount: job.failedCount + state.failed.length, params: job.params });
  return undefined;
}

// GET /bulk/jobs/:id — the member's own job.
async function getJob(req, id) {
  const job = await BulkJob.findOne({ _id: id, organizationId: req.tenant.organizationId, memberId: req.member._id });
  if (!job) throw httpError(404, 'NOT_FOUND', 'Bulk action not found');
  return serializeJob(job);
}

function register(queue) {
  queue.define(JOB, runJob, { maxAttempts: 3 });
}

module.exports = {
  start, getJob, register, runJob, MAX_IDS, INLINE_MAX, OBJECTS,
  // D89's entry point (Boards).
  leads: (req, body, key) => start(req, 'lead', body, key),
};
