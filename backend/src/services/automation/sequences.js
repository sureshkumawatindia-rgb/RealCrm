const mongoose = require('mongoose');
const Conversation = require('../../models/Conversation');
const Organization = require('../../models/Organization');
const Sequence = require('../../models/Sequence');
const SequenceEnrollment = require('../../models/SequenceEnrollment');
const queue = require('../../jobs/queue');
const logger = require('../../config/logger');
const { businessHoursOf, nextOpening } = require('../../utils/businessHours');
const { MAX_CHAIN } = require('../../constants/automation');
const { ACTIONS } = require('./actions');
const { loadContext, leadOfContact, systemReq } = require('./context');

// Follow-up sequences per customer (Phase 6B). Enrolling (by a person, or a workflow's "add to
// sequence" step) schedules step 0; each step runs in a "sequence.step" job on its day (after
// enrolling; a step due outside working hours waits for the next opening) through the same
// actions as workflows; a refused step (4xx: e.g. a template Meta paused) is logged as failed
// and the sequence carries on. A customer's WhatsApp reply or their lead being won or lost stops the
// sequence for them: the engine's "automation.event" job calls handleEvent before it runs any
// workflow, and each step checks again before it runs.
const JOBS = { STEP: 'sequence.step' };
const DAY = 24 * 60 * 60 * 1000;
const CLOSED = ['Won', 'Lost'];

// The sequence as the "workflow" its actions run for.
const sourceOf = (sequence) => ({
  _id: sequence._id, organizationId: sequence.organizationId, name: sequence.name, kind: 'sequence', actorName: `Sequence "${sequence.name}"`,
});

async function dueAt(sequence, enrolledAt, index) {
  const at = new Date(Math.max(Date.now(), new Date(enrolledAt).getTime() + sequence.steps[index].day * DAY));
  if (!sequence.workingHoursOnly) return at;
  const organization = await Organization.findById(sequence.organizationId).select('businessHours');
  return nextOpening(businessHoursOf(organization), at);
}

const stepKey = (enrollmentId, index) => `seq:${enrollmentId}:${index}`;
function scheduleStep(enrollment, index, runAt) {
  return queue.enqueue(JOBS.STEP, { enrollmentId: String(enrollment._id) }, { runAt, uniqueKey: stepKey(enrollment._id, index), organizationId: enrollment.organizationId, maxAttempts: 4 });
}

// The counts on the sequence card (enrolled is history and only grows).
async function refreshStats(sequenceId) {
  const rows = await SequenceEnrollment.aggregate([{ $match: { sequenceId: new mongoose.Types.ObjectId(String(sequenceId)) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const count = Object.fromEntries(rows.map((row) => [row._id, row.n]));
  await Sequence.updateOne({ _id: sequenceId }, {
    $set: { 'stats.active': count.active || 0, 'stats.completed': count.completed || 0, 'stats.stopped': count.stopped || 0, 'stats.failed': count.failed || 0 },
  });
}

// Ends an active enrollment (only once, whoever gets there first).
async function finish(enrollment, status, reason = '') {
  const updated = await SequenceEnrollment.findOneAndUpdate(
    { _id: enrollment._id, status: 'active' },
    { $set: { status, stopReason: status === 'stopped' ? reason : '', error: status === 'failed' ? String(reason).slice(0, 1000) : '', finishedAt: new Date() }, $unset: { nextAt: 1 } },
    { returnDocument: 'after' },
  );
  if (!updated) return null;
  await queue.cancel(stepKey(updated._id, updated.stepIndex));
  await refreshStats(updated.sequenceId);
  return updated;
}

// → { enrollment, sequence } or { reason } (not enrolled: paused, already in it …).
async function enroll({ organizationId, sequenceId, contact, lead, by, chain = [] }) {
  const sequence = await Sequence.findOne({ _id: sequenceId, organizationId });
  if (!sequence) return { reason: 'The sequence was removed.' };
  if (sequence.status !== 'Active') return { sequence, reason: `The sequence "${sequence.name}" is ${sequence.status.toLowerCase()}.` };
  if (!sequence.steps.length) return { sequence, reason: `The sequence "${sequence.name}" has no steps.` };
  if (chain.length >= MAX_CHAIN) return { sequence, reason: 'Too many automations in a row; not added.' };
  const theLead = lead || (await leadOfContact(organizationId, contact._id));
  let enrollment;
  try {
    enrollment = await SequenceEnrollment.create({
      organizationId, sequenceId: sequence._id, sequenceName: sequence.name, contactId: contact._id, leadId: theLead?._id, label: contact.name || theLead?.title || '',
      enrolledBy: by, chain,
    });
  } catch (error) {
    if (error.code === 11000) return { sequence, alreadyEnrolled: true, reason: `Already in the sequence "${sequence.name}".` };
    throw error;
  }
  enrollment.nextAt = await dueAt(sequence, enrollment.enrolledAt, 0);
  await enrollment.save();
  await Sequence.updateOne({ _id: sequence._id }, { $inc: { 'stats.enrolled': 1 }, $set: { 'stats.lastEnrolledAt': new Date() } });
  await refreshStats(sequence._id);
  await scheduleStep(enrollment, 0, enrollment.nextAt);
  return { enrollment, sequence };
}

// The customer wrote on WhatsApp after being enrolled.
const repliedSince = (enrollment) =>
  Conversation.exists({ organizationId: enrollment.organizationId, contactId: enrollment.contactId, lastInboundAt: { $gt: enrollment.enrolledAt } });

async function runStep({ enrollmentId }, job) {
  const enrollment = await SequenceEnrollment.findById(enrollmentId);
  if (!enrollment || enrollment.status !== 'active') return;
  const sequence = await Sequence.findById(enrollment.sequenceId);
  if (!sequence) return finish(enrollment, 'stopped', 'The sequence was deleted.');
  if (sequence.status !== 'Active') return finish(enrollment, 'stopped', `The sequence was set to ${sequence.status}.`);
  const index = enrollment.stepIndex;
  const step = sequence.steps[index];
  if (!step) return finish(enrollment, 'completed');
  if (sequence.stopOnReply && (await repliedSince(enrollment))) return finish(enrollment, 'stopped', 'The customer replied on WhatsApp.');
  const ctx = await loadContext({ organizationId: enrollment.organizationId, subject: { leadId: enrollment.leadId, contactId: enrollment.contactId } });
  if (!ctx.contact) return finish(enrollment, 'stopped', 'The customer was removed.');
  if (sequence.stopOnClose && CLOSED.includes(ctx.lead?.stage)) return finish(enrollment, 'stopped', `The lead was ${ctx.lead.stage.toLowerCase()}.`);

  const source = sourceOf(sequence);
  let result;
  try {
    result = await ACTIONS[step.type]({ ctx, params: step.params || {}, run: enrollment, workflow: source, req: systemReq(enrollment, source) });
  } catch (error) {
    const refused = Boolean(error.statusCode && error.statusCode < 500);
    if (!refused && job && job.attempts < job.maxAttempts) throw error; // the job tries this step again
    if (!refused) {
      // Still failing after the retries: something is wrong beyond this customer.
      await SequenceEnrollment.updateOne({ _id: enrollment._id }, { $push: { steps: { index, day: step.day, type: step.type, status: 'failed', detail: String(error.message || error).slice(0, 500) } } });
      logger.warn(`Sequence enrollment ${enrollment._id} failed at step ${index} (${step.type}): ${error.message}`);
      return finish(enrollment, 'failed', error.message);
    }
    result = { status: 'failed', detail: error.message };
  }
  await SequenceEnrollment.updateOne({ _id: enrollment._id }, {
    $push: { steps: { index, day: step.day, type: step.type, status: result?.status || 'done', detail: String(result?.detail || '').slice(0, 500) } },
  });
  const next = index + 1;
  if (next >= sequence.steps.length) {
    await SequenceEnrollment.updateOne({ _id: enrollment._id, status: 'active' }, { $set: { stepIndex: next } });
    return finish(enrollment, 'completed');
  }
  const nextAt = await dueAt(sequence, enrollment.enrolledAt, next);
  const moved = await SequenceEnrollment.updateOne({ _id: enrollment._id, status: 'active', stepIndex: index }, { $set: { stepIndex: next, nextAt } });
  if (moved.modifiedCount) await scheduleStep(enrollment, next, nextAt);
  return undefined;
}

// Stops the enrollments a reply or a won/lost lead ends.
async function handleEvent(event) {
  const organizationId = event.organizationId;
  let filter;
  let reason;
  let option;
  if (event.type === 'message.received' && event.contactId) {
    // Only those enrolled before this message (a workflow may enroll on this very message).
    filter = { organizationId, contactId: event.contactId, enrolledAt: { $lt: new Date(event.at || Date.now()) } };
    reason = 'The customer replied on WhatsApp.';
    option = 'stopOnReply';
  } else if (event.type === 'lead.stage_changed' && CLOSED.includes(event.to) && event.leadId) {
    filter = { organizationId, leadId: event.leadId };
    reason = `The lead was ${String(event.to).toLowerCase()}.`;
    option = 'stopOnClose';
  } else return 0;
  const active = await SequenceEnrollment.find({ ...filter, status: 'active' });
  let stopped = 0;
  for (const enrollment of active) {
    const sequence = await Sequence.findById(enrollment.sequenceId).select(option);
    if (sequence && !sequence[option]) continue;
    if (await finish(enrollment, 'stopped', reason)) stopped += 1;
  }
  return stopped;
}

// A sequence paused or deleted: everyone in it stops.
async function stopAll(sequence, reason) {
  const active = await SequenceEnrollment.find({ sequenceId: sequence._id, status: 'active' }).select('_id stepIndex');
  if (!active.length) return 0;
  await SequenceEnrollment.updateMany({ sequenceId: sequence._id, status: 'active' }, { $set: { status: 'stopped', stopReason: reason, finishedAt: new Date() }, $unset: { nextAt: 1 } });
  for (const enrollment of active) await queue.cancel(stepKey(enrollment._id, enrollment.stepIndex));
  await refreshStats(sequence._id);
  return active.length;
}

function register(jobQueue) {
  jobQueue.define(JOBS.STEP, (data, job) => runStep(data, job), { maxAttempts: 4 });
}

module.exports = { register, JOBS, enroll, finish, stopAll, runStep, handleEvent, refreshStats };
