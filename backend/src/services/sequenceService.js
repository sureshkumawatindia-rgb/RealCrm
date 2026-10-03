const Contact = require('../models/Contact');
const Sequence = require('../models/Sequence');
const SequenceEnrollment = require('../models/SequenceEnrollment');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { toPage, paginationMeta } = require('../utils/pagination');
const { createOwnedRecordService } = require('./ownedRecordService');
const { visibilityFilter } = require('./access');
const leadService = require('./leadService');
const workflowService = require('./workflowService');
const sequences = require('./automation/sequences');

// Follow-up sequences (Sales Automation → Sequences, Phase 6B): the settings, enrolling a
// customer by hand, and who is in a sequence. The schedule itself runs in automation/sequences.js.
const MODULES = ['automation'];
const invalid = (field, message, code) => httpError(400, 'VALIDATION_ERROR', message, [{ field, code, message }]);
const plain = (value) => (value && typeof value.toObject === 'function' ? value.toObject() : value);

function serializeSequence(sequence) {
  return {
    id: sequence._id,
    name: sequence.name,
    status: sequence.status,
    steps: (sequence.steps || []).map(({ day, type, params }) => ({ day, type, params: plain(params) || {} })),
    stopOnReply: sequence.stopOnReply,
    stopOnClose: sequence.stopOnClose,
    workingHoursOnly: sequence.workingHoursOnly,
    notes: sequence.notes || [],
    ownerId: sequence.ownerId || null,
    stats: {
      enrolled: sequence.stats?.enrolled || 0, active: sequence.stats?.active || 0, completed: sequence.stats?.completed || 0,
      stopped: sequence.stats?.stopped || 0, failed: sequence.stats?.failed || 0, lastEnrolledAt: sequence.stats?.lastEnrolledAt || null,
    },
    createdByMemberId: sequence.createdByMemberId || null,
    createdAt: sequence.createdAt,
    updatedAt: sequence.updatedAt,
  };
}

function serializeEnrollment(enrollment) {
  return {
    id: enrollment._id,
    sequenceId: enrollment.sequenceId,
    sequenceName: enrollment.sequenceName,
    contactId: enrollment.contactId,
    leadId: enrollment.leadId || null,
    label: enrollment.label,
    status: enrollment.status,
    enrolledAt: enrollment.enrolledAt,
    enrolledBy: { kind: enrollment.enrolledBy?.kind || 'member', name: enrollment.enrolledBy?.name || '', workflowId: enrollment.enrolledBy?.workflowId || null },
    stepIndex: enrollment.stepIndex,
    nextAt: enrollment.nextAt || null,
    steps: enrollment.steps.map(({ index, day, type, status, detail, at }) => ({ index, day, type, status, detail, at })),
    stopReason: enrollment.stopReason || '',
    error: enrollment.error || '',
    finishedAt: enrollment.finishedAt || null,
  };
}

const base = createOwnedRecordService({
  Model: Sequence,
  modules: MODULES,
  entityType: 'Sequence',
  label: 'Sequence',
  fields: ['name', 'status', 'steps', 'stopOnReply', 'stopOnClose', 'workingHoursOnly'],
  searchFields: ['name'],
  sorts: ['createdAt', 'updatedAt', 'name', 'status'],
  defaultSort: { createdAt: -1 },
  filters: (query) => ({ ...(query.status && { status: query.status }), ...(query.ownerId && { ownerId: query.ownerId }) }),
  // Steps run in day order (the same day keeps the order they were given in).
  prepare: (record) => {
    const ordered = record.steps.map((step, index) => [step, index]).sort((a, b) => a[0].day - b[0].day || a[1] - b[1]).map(([step]) => plain(step));
    record.set('steps', ordered);
  },
  serialize: serializeSequence,
});

async function create(req, body) {
  if (body.steps) await workflowService.checkReferences(req, { steps: body.steps });
  return base.create(req, body);
}

async function update(req, id, body) {
  const sequence = await base.findVisible(req, id);
  if (body.steps || body.status === 'Active') {
    await workflowService.checkReferences(req, { steps: body.steps || sequence.steps.map(({ type, params }) => ({ type, params: plain(params) })) });
  }
  if (body.status === 'Active' && !(body.steps || sequence.steps).length) throw invalid('steps', 'Add at least one step before turning this sequence on.', 'STEPS_REQUIRED');
  const wasActive = sequence.status === 'Active';
  const updated = await base.update(req, id, body);
  if (wasActive && updated.status !== 'Active') await sequences.stopAll(sequence, `Stopped: the sequence was set to ${updated.status}.`);
  return serializeSequence(await Sequence.findById(id));
}

async function remove(req, id) {
  const sequence = await base.findVisible(req, id);
  await base.remove(req, id);
  await sequences.stopAll(sequence, 'Stopped: the sequence was deleted.');
}

// Enroll by hand: a lead (its customer) or a customer (their open lead, if any).
async function enroll(req, id, { leadId, contactId }) {
  const sequence = await base.findVisible(req, id);
  if (sequence.status !== 'Active') throw httpError(409, 'NOT_ACTIVE', 'Only an active sequence can take customers. Set it to Active first.');
  let lead = null;
  let contact;
  if (leadId) {
    lead = await leadService.findVisible(req, leadId);
    contact = await Contact.findOne({ _id: lead.contactId, organizationId: req.tenant.organizationId });
  } else {
    contact = await Contact.findOne({ _id: contactId, organizationId: req.tenant.organizationId, ...visibilityFilter(req, 'customers') });
  }
  if (!contact) throw httpError(404, 'NOT_FOUND', 'Customer not found');
  const result = await sequences.enroll({
    organizationId: req.tenant.organizationId, sequenceId: sequence._id, contact, lead,
    by: { kind: 'member', memberId: req.member._id, name: req.user.name || '' },
  });
  if (result.alreadyEnrolled) throw httpError(409, 'ALREADY_ENROLLED', `${contact.name || 'This customer'} is already in "${sequence.name}".`);
  if (!result.enrollment) throw httpError(409, 'NOT_ENROLLED', result.reason);
  await audit(req, { action: 'sequence.enrolled', entityType: 'Sequence', entityId: sequence._id, changes: { contactId: String(contact._id), enrollmentId: String(result.enrollment._id) } });
  return serializeEnrollment(result.enrollment);
}

// Members who see only their own sequences see only who is in those.
async function enrollmentScope(req) {
  const organizationId = req.tenant.organizationId;
  const visibility = visibilityFilter(req, MODULES);
  if (!Object.keys(visibility).length) return { organizationId };
  const own = await Sequence.find({ organizationId, ...visibility }).select('_id');
  return { organizationId, sequenceId: { $in: own.map((s) => s._id) } };
}

async function listEnrollments(req, query) {
  const scope = await enrollmentScope(req);
  const filter = {
    ...scope,
    ...(query.sequenceId && { sequenceId: scope.sequenceId ? { $in: scope.sequenceId.$in.filter((s) => String(s) === query.sequenceId) } : query.sequenceId }),
    ...(query.contactId && { contactId: query.contactId }),
    ...(query.leadId && { leadId: query.leadId }),
    ...(query.status && { status: query.status }),
  };
  const page = toPage(query);
  const [items, total] = await Promise.all([
    SequenceEnrollment.find(filter).sort({ createdAt: -1 }).skip(page.skip).limit(page.limit),
    SequenceEnrollment.countDocuments(filter),
  ]);
  return { items: items.map(serializeEnrollment), pagination: paginationMeta(page, total) };
}

async function findEnrollment(req, id) {
  const enrollment = await SequenceEnrollment.findOne({ _id: id, ...(await enrollmentScope(req)) });
  if (!enrollment) throw httpError(404, 'NOT_FOUND', 'Enrollment not found');
  return enrollment;
}

async function stopEnrollment(req, id) {
  const enrollment = await findEnrollment(req, id);
  const stopped = await sequences.finish(enrollment, 'stopped', `Stopped by ${req.user.name}.`);
  if (!stopped) throw httpError(409, 'ENROLLMENT_FINISHED', 'This customer is no longer in the sequence.');
  await audit(req, { action: 'sequence.enrollment_stopped', entityType: 'SequenceEnrollment', entityId: enrollment._id });
  return serializeEnrollment(stopped);
}

module.exports = {
  MODULES,
  list: base.list,
  get: base.get,
  create,
  update,
  remove,
  findVisible: base.findVisible,
  enroll,
  listEnrollments,
  getEnrollment: async (req, id) => serializeEnrollment(await findEnrollment(req, id)),
  stopEnrollment,
  serializeSequence,
  serializeEnrollment,
};
