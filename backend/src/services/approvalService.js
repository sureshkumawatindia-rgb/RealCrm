const crypto = require('crypto');
const mongoose = require('mongoose');
const ApprovalRule = require('../models/ApprovalRule');
const OrganizationMember = require('../models/OrganizationMember');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { isManager } = require('../constants/permissions');
const { MAX_APPROVAL_RULES } = require('../constants/approvals');
const customFieldService = require('./customFieldService');

// Approval rules (Phase 1E, D77). Owners and admins set limits in Settings → Approvals ("discount
// above 10%", "total above ₹5,00,000"); a draft quotation over a limit cannot reach the customer,
// for the roles the rule names, until an owner or admin approves it. Whether a quotation needs
// approval is worked out on every read from the active rules, so archiving a rule frees its
// quotations at once. The asking and deciding live in quotationService.

const forbidden = () => httpError(403, 'FORBIDDEN', 'You do not have permission to do this.');
const scope = (req, filter = {}) => ({ ...filter, organizationId: req.tenant.organizationId });
const conflict = () => httpError(409, 'VERSION_CONFLICT', 'Someone else changed this rule. Reload and try again.');
const limitError = () => httpError(422, 'RULE_LIMIT', `Up to ${MAX_APPROVAL_RULES} active approval rules. Archive one first.`);
const noCondition = () => httpError(400, 'VALIDATION_ERROR', 'Set a discount limit, a total limit or both.', [{ field: 'discountPercentAbove', code: 'NO_CONDITION', message: 'Set a discount limit, a total limit or both.' }]);

function serializeRule(rule) {
  return {
    id: rule._id,
    name: rule.name,
    discountPercentAbove: rule.discountPercentAbove ?? null,
    grandTotalAbovePaise: rule.grandTotalAbovePaise ?? null,
    appliesTo: rule.appliesTo?.length ? rule.appliesTo : ['agent'],
    status: rule.status,
    archivedAt: rule.archivedAt || null,
    version: rule.version,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

async function findRule(req, id, session) {
  const rule = await ApprovalRule.findOne(scope(req, { _id: id })).session(session || null);
  if (!rule) throw httpError(404, 'NOT_FOUND', 'Rule not found');
  return rule;
}

// GET /approval-rules — the active rules (agents see their limits in the quotation editor);
// archived ones too for owners and admins (?status=all).
async function listRules(req, { status = 'active' } = {}) {
  if (status === 'all' && !isManager(req.member)) throw forbidden();
  const rules = await ApprovalRule.find(scope(req, { object: 'quotation', ...(status === 'active' && { status: 'active' }) })).sort({ status: 1, createdAt: 1 });
  return rules.map(serializeRule);
}

const hasCondition = (rule) => rule.discountPercentAbove != null || rule.grandTotalAbovePaise != null;

// A new or restored rule takes its turn (the company's settings revision), so two admins at once
// cannot pass the limit.
async function assertRoom(req, session) {
  await customFieldService.takeTurn(req, session);
  if (await ApprovalRule.countDocuments(scope(req, { object: 'quotation', status: 'active' })).session(session) >= MAX_APPROVAL_RULES) throw limitError();
}

async function createRule(req, body) {
  if (!hasCondition(body)) throw noCondition();
  let rule;
  await mongoose.connection.transaction(async (session) => {
    rule = null;
    await assertRoom(req, session);
    [rule] = await ApprovalRule.create([{
      organizationId: req.tenant.organizationId,
      name: body.name,
      discountPercentAbove: body.discountPercentAbove ?? undefined,
      grandTotalAbovePaise: body.grandTotalAbovePaise ?? undefined,
      appliesTo: body.appliesTo || ['agent'],
      createdById: req.user._id,
      updatedById: req.user._id,
    }], { session });
  });
  await audit(req, { action: 'approval_rule.created', entityType: 'ApprovalRule', entityId: rule._id, changes: serializeRule(rule) });
  return serializeRule(rule);
}

// name, the two conditions (null takes one away) and appliesTo; at least one condition stays.
async function updateRule(req, id, body) {
  const rule = await findRule(req, id);
  if (body.version !== undefined && body.version !== rule.version) throw conflict();
  const set = {};
  const unset = {};
  for (const key of ['name', 'appliesTo']) if (key in body) set[key] = body[key];
  for (const key of ['discountPercentAbove', 'grandTotalAbovePaise']) {
    if (!(key in body)) continue;
    if (body[key] === null) unset[key] = 1;
    else set[key] = body[key];
  }
  const after = { discountPercentAbove: rule.discountPercentAbove, grandTotalAbovePaise: rule.grandTotalAbovePaise, ...set };
  for (const key of Object.keys(unset)) after[key] = undefined;
  if (!hasCondition(after)) throw noCondition();
  const updated = await ApprovalRule.findOneAndUpdate(
    scope(req, { _id: rule._id, version: rule.version }),
    { $set: { ...set, updatedById: req.user._id }, ...(Object.keys(unset).length && { $unset: unset }), $inc: { version: 1 } },
    { returnDocument: 'after', runValidators: true },
  );
  if (!updated) throw conflict();
  await audit(req, { action: 'approval_rule.updated', entityType: 'ApprovalRule', entityId: rule._id, changes: [...Object.keys(set), ...Object.keys(unset)] });
  return serializeRule(updated);
}

async function archiveRule(req, id) {
  const rule = await findRule(req, id);
  if (rule.status === 'archived') return serializeRule(rule);
  const updated = await ApprovalRule.findOneAndUpdate(
    scope(req, { _id: rule._id, status: 'active' }),
    { $set: { status: 'archived', archivedAt: new Date(), updatedById: req.user._id }, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
  await audit(req, { action: 'approval_rule.archived', entityType: 'ApprovalRule', entityId: rule._id });
  return serializeRule(updated || await findRule(req, id));
}

async function restoreRule(req, id) {
  let rule;
  let restored = false;
  await mongoose.connection.transaction(async (session) => {
    restored = false;
    rule = await findRule(req, id, session);
    if (rule.status === 'active') return;
    await assertRoom(req, session);
    rule.set({ status: 'active', archivedAt: undefined, updatedById: req.user._id });
    rule.version += 1;
    await rule.save({ session });
    restored = true;
  });
  if (restored) await audit(req, { action: 'approval_rule.restored', entityType: 'ApprovalRule', entityId: rule._id });
  return serializeRule(rule);
}

// --- a quotation against the rules ---------------------------------------------------------

// The company's active rules, read once per request.
function activeRules(req) {
  if (!req.approvalRules) {
    req.approvalRules = ApprovalRule.find(scope(req, { object: 'quotation', status: 'active' })).sort({ createdAt: 1 }).lean().exec();
  }
  return req.approvalRules;
}

// The whole quotation's discount as a % of its subtotal, to 2 decimals.
function discountPercentOf(totals) {
  const subtotal = totals?.subtotalPaise || 0;
  return subtotal > 0 ? Math.round(((totals.discountPaise || 0) * 10000) / subtotal) / 100 : 0;
}

// Which limits a quotation with these totals crosses for someone of this role: [{ ruleId,
// ruleName, kind, value, limit }] (discount in %, total in paise). Owners are never stopped.
function reasonsFor(rules, totals, role) {
  const reasons = [];
  const subtotal = totals?.subtotalPaise || 0;
  const discount = totals?.discountPaise || 0;
  const grandTotal = totals?.grandTotalPaise || 0;
  for (const rule of rules || []) {
    if (!(rule.appliesTo?.length ? rule.appliesTo : ['agent']).includes(role)) continue;
    // "More than": compared exactly, in hundredths of a percent.
    if (rule.discountPercentAbove != null && subtotal > 0 && discount * 10000 > Math.round(rule.discountPercentAbove * 100) * subtotal) {
      reasons.push({ ruleId: rule._id, ruleName: rule.name, kind: 'discount', value: discountPercentOf(totals), limit: rule.discountPercentAbove });
    }
    if (rule.grandTotalAbovePaise != null && grandTotal > rule.grandTotalAbovePaise) {
      reasons.push({ ruleId: rule._id, ruleName: rule.name, kind: 'total', value: grandTotal, limit: rule.grandTotalAbovePaise });
    }
  }
  return reasons;
}

// What an approval is given for: the lines and the totals. Any change to them needs a new one.
function fingerprintOf(quotation) {
  const plain = (value) => (value?.toObject ? value.toObject() : value);
  const items = (quotation.items || []).map((item) => {
    const line = plain(item);
    return [String(line.productId || ''), line.name, line.quantity, line.unitPricePaise, line.discountType, line.discountValue, line.gstRatePct];
  });
  const totals = plain(quotation.totals) || {};
  const text = JSON.stringify([items, totals.subtotalPaise, totals.discountPaise, totals.grandTotalPaise]);
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

// The live approval (null when there is none, or it was for other lines or totals).
function currentApproval(quotation) {
  const approval = quotation.approval;
  return approval?.state && approval.fingerprint === fingerprintOf(quotation) ? approval : null;
}

async function namesOf(ids) {
  const wanted = [...new Set(ids.filter(Boolean).map(String))];
  if (!wanted.length) return new Map();
  const members = await OrganizationMember.find({ _id: { $in: wanted } }).select('displayName userId').populate('userId', 'name');
  return new Map(members.map((m) => [String(m._id), m.displayName || m.userId?.name || '']));
}

// For each quotation, what this member sees and may do:
// { needed, blocked, state, reasons, requestedBy, requestedAt, decidedBy, decidedAt, comment, canAsk, canDecide }
async function viewsOf(req, quotations) {
  const rules = await activeRules(req);
  const approvals = quotations.map(currentApproval);
  const names = await namesOf(approvals.flatMap((a) => [a?.requestedById, a?.decidedById]));
  const person = (id) => (id ? { id, name: names.get(String(id)) || '' } : null);
  return quotations.map((quotation, index) => {
    const approval = approvals[index];
    const draft = quotation.status === 'Draft';
    const reasons = draft ? reasonsFor(rules, quotation.totals, req.member?.role) : [];
    const state = approval?.state || null;
    const plainReasons = (list) => (list || []).map((r) => ({ ruleId: r.ruleId, ruleName: r.ruleName, kind: r.kind, value: r.value, limit: r.limit }));
    return {
      needed: reasons.length > 0,
      blocked: reasons.length > 0 && state !== 'approved',
      state,
      // An approver sees the limits it was asked for; the one sending, those that apply to them now.
      reasons: plainReasons(reasons.length ? reasons : approval?.reasons),
      requestedBy: person(approval?.requestedById),
      requestedAt: approval?.requestedAt || null,
      decidedBy: person(approval?.decidedById),
      decidedAt: approval?.decidedAt || null,
      comment: approval?.comment || '',
      canAsk: reasons.length > 0 && !['pending', 'approved'].includes(state),
      canDecide: draft && state === 'pending' && isManager(req.member) && String(approval.requestedById) !== String(req.member._id),
    };
  });
}

// Sending, marking sent or accepted, and the PDF of a draft: refused while it needs approval for
// this member and has none.
async function assertSendable(req, quotation) {
  if (quotation.status !== 'Draft') return;
  const reasons = reasonsFor(await activeRules(req), quotation.totals, req.member?.role);
  if (!reasons.length || currentApproval(quotation)?.state === 'approved') return;
  const pending = currentApproval(quotation)?.state === 'pending';
  throw httpError(409, 'APPROVAL_REQUIRED', pending
    ? 'This quotation is waiting for approval from an owner or admin.'
    : 'This quotation needs approval from an owner or admin first. Ask for approval.');
}

// An approval as outbound webhooks carry it (D78): ids as strings, no names.
const publicApproval = (a) => (a?.state ? {
  state: a.state,
  reasons: (a.reasons || []).map((r) => ({ ruleName: r.ruleName, kind: r.kind, value: r.value, limit: r.limit })),
  requestedById: a.requestedById ? String(a.requestedById) : null, requestedAt: a.requestedAt || null,
  decidedById: a.decidedById ? String(a.decidedById) : null, decidedAt: a.decidedAt || null, comment: a.comment || '',
} : null);

module.exports = {
  publicApproval,
  serializeRule, listRules, createRule, updateRule, archiveRule, restoreRule,
  activeRules, reasonsFor, discountPercentOf, fingerprintOf, currentApproval, viewsOf, assertSendable, namesOf,
};
