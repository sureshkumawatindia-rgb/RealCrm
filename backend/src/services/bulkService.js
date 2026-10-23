const Contact = require('../models/Contact');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { can } = require('../constants/permissions');
const leadService = require('./leadService');
const sequenceService = require('./sequenceService');
const smsService = require('./smsService');
const { loadContext } = require('./automation/context');
const { resolveVariables } = require('./automation/actions');

// Bulk actions on leads (Phase 8B, D89): up to 200 at once. Every row goes through the same
// service as one change by hand (visibility, owner rules, versions, plan limits, consent), so a
// row the member may not change fails on its own and is listed; the rest are done.
const MAX_IDS = 200;

const ACTIONS = {
  assign: (req, id, p) => leadService.update(req, id, { ownerId: p.ownerId || null }),
  stage: (req, id, p) => leadService.changeStage(req, id, { stage: p.stage, ...(p.lostReason && { lostReason: p.lostReason }) }),
  followUp: (req, id, p) => leadService.update(req, id, { followUpAt: p.at || null }),
  async tag(req, id, p) {
    const lead = await leadService.findVisible(req, id);
    await Contact.updateOne({ _id: lead.contactId, organizationId: req.tenant.organizationId }, { $addToSet: { tags: p.tag } });
  },
  sequence: (req, id, p) => sequenceService.enroll(req, p.sequenceId, { leadId: id }),
  async sms(req, id, p, key) {
    const lead = await leadService.findVisible(req, id);
    const organizationId = req.tenant.organizationId;
    const ctx = await loadContext({ organizationId, subject: { leadId: lead._id } });
    if (!ctx.contact) throw httpError(404, 'NOT_FOUND', 'The customer was removed.');
    return smsService.sendFromStep({
      organizationId, contact: ctx.contact, lead, templateKey: p.template, valuesFor: () => resolveVariables({ body: p.variables || {} }, ctx).body,
      source: 'bulk', memberId: req.member._id, idempotencyKey: key ? `bulk:${key}:${id}` : undefined,
    });
  },
};
// What else an action needs, beyond editing leads.
const NEEDS = { sequence: ['automation', 'edit', 'Adding to a sequence needs Sales Automation.'], sms: ['customers', 'edit', 'Sending SMS needs Customers (edit).'] };

// POST /bulk/leads { action, ids, params } → { action, total, done, failed: [{ id, code, message }] }
async function leads(req, { action, ids, params = {} }, key) {
  const need = NEEDS[action];
  if (need && !can(req.member, need[0], need[1])) throw httpError(403, 'FORBIDDEN', need[2]);
  const unique = [...new Set(ids.map(String))].slice(0, MAX_IDS);
  let done = 0;
  const failed = [];
  for (const id of unique) {
    try {
      await ACTIONS[action](req, id, params, key);
      done += 1;
    } catch (error) {
      if (!error.statusCode || error.statusCode >= 500) throw error;
      failed.push({ id, code: error.code || 'ERROR', message: error.message });
    }
  }
  await audit(req, { action: `lead.bulk_${action}`, entityType: 'Lead', changes: { total: unique.length, done, failed: failed.length, params } });
  return { action, total: unique.length, done, failed };
}

module.exports = { leads, MAX_IDS };
