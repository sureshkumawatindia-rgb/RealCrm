const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const Product = require('../models/Product');
const Lead = require('../models/Lead');
const LeadSourceConnection = require('../models/LeadSourceConnection');
const Pipeline = require('../models/Pipeline');
const Invite = require('../models/Invite');
const Quotation = require('../models/Quotation');
const QuickReply = require('../models/QuickReply');
const pipelineService = require('./pipelineService');
const quickReplyService = require('./quickReplyService');
const organizationService = require('./organizationService');
const { audit } = require('../utils/audit');
const { KITS, CHOOSABLE_KIT_IDS, KIT_LANGUAGES, GETTING_STARTED_STEPS } = require('../constants/businessKits');
const { DEFAULT_STAGES } = require('../constants/pipelines');

// The first day (100 phases, phase 5, D117). The "Getting started" list of an owner or admin,
// worked out from the company's own data in one call: each step ticks itself once it is done.
// And ready settings for a trader or a manufacturer (constants/businessKits.js): the default
// pipeline's stages, quick replies for the Inbox and the quotation terms, in the person's
// language. A kit fills only what the company has not set itself, so applying one twice, or a
// second one later, never overwrites anything.

// A kit's words: in the language asked for, else the person's own, else English.
const languageOf = (req, language) => [language, req.user.preferences?.language].find((code) => KIT_LANGUAGES.includes(code)) || 'en';

// The default pipeline still has the stages every company starts with (none renamed or added).
const untouched = (pipeline) => pipeline.stages.length === DEFAULT_STAGES.length
  && pipeline.stages.every((stage, index) => stage.name === DEFAULT_STAGES[index].name && stage.kind === DEFAULT_STAGES[index].kind);

// GET /organization/getting-started
async function status(req) {
  const { organizationId } = req.tenant;
  const [organization, pipeline, replies, whatsapp, products, leads, sources, members, invites, quotation] = await Promise.all([
    Organization.findById(organizationId).select('gstin address onboarding billing.terms').lean(),
    Pipeline.findOne({ organizationId, isDefault: true }).select('stages.name stages.kind').lean(),
    QuickReply.exists({ organizationId }),
    WhatsAppAccount.exists({ organizationId }),
    Product.exists({ organizationId }),
    Lead.exists({ organizationId }),
    LeadSourceConnection.exists({ organizationId }),
    OrganizationMember.countDocuments({ organizationId, status: 'active' }),
    Invite.exists({ organizationId, status: 'pending' }),
    // Sent: anything past a draft (sent, seen, accepted, rejected or expired).
    Quotation.exists({ organizationId, status: { $ne: 'Draft' } }),
  ]);
  const done = {
    business: Boolean(organization?.gstin || organization?.address),
    // Ready settings: a kit chosen, or the company's own stages, quick replies and terms already.
    kit: Boolean(organization?.onboarding?.kit) || Boolean(pipeline && !untouched(pipeline) && replies && organization?.billing?.terms?.trim()),
    whatsapp: Boolean(whatsapp),
    products: Boolean(products),
    // Leads in the CRM by any road: added by hand, imported from a file (they are leads then too)
    // or a lead source connected.
    leads: Boolean(leads || sources),
    team: members > 1 || Boolean(invites),
    quote: Boolean(quotation),
  };
  const steps = GETTING_STARTED_STEPS.map((key) => ({ key, done: done[key] }));
  return {
    steps,
    done: steps.filter((step) => step.done).length,
    total: steps.length,
    kit: organization?.onboarding?.kit || null,
    hidden: Boolean(req.member.checklistHiddenAt),
  };
}

// PATCH /organization/getting-started { hidden } — for this person, on every device.
async function setHidden(req, { hidden }) {
  await OrganizationMember.updateOne({ _id: req.member._id }, hidden ? { $set: { checklistHiddenAt: new Date() } } : { $unset: { checklistHiddenAt: 1 } });
  req.member.checklistHiddenAt = hidden ? new Date() : undefined;
  return status(req);
}

// GET /organization/business-kits?language= — every kit in that language, and what the company
// has set itself already (it stays).
async function kits(req, { language } = {}) {
  const { organizationId } = req.tenant;
  const lang = languageOf(req, language);
  const [organization, pipeline, billing, replies] = await Promise.all([
    Organization.findById(organizationId).select('onboarding').lean(),
    pipelineService.ensureDefault(organizationId),
    organizationService.getBilling(req),
    QuickReply.find({ organizationId }).select('shortcut').lean(),
  ]);
  const shortcuts = new Set(replies.map((reply) => reply.shortcut));
  return {
    language: lang,
    current: organization?.onboarding?.kit || null,
    keeps: { stages: !untouched(pipeline), terms: Boolean(billing.terms.trim()) },
    kits: CHOOSABLE_KIT_IDS.map((id) => {
      const kit = KITS[id];
      return {
        id,
        name: kit.name[lang],
        about: kit.about[lang],
        stages: kit.stages.map((stage) => stage.name[lang]),
        quickReplies: kit.quickReplies.map((reply) => ({ shortcut: reply.shortcut, title: reply.title[lang], body: reply.body[lang], exists: shortcuts.has(reply.shortcut) })),
        terms: kit.terms[lang],
        validityDays: kit.validityDays,
      };
    }),
  };
}

// POST /organization/business-kit { kit, language } — fills what is not set yet. → what it did.
async function applyKit(req, { kit: id, language }) {
  const { organizationId } = req.tenant;
  const lang = languageOf(req, language);
  const kit = KITS[id];

  // The stages: only over the stages every company starts with; each keeps its id (and so its
  // leads), and a kit's second stage of a kind ("Sample sent") comes after the first.
  let stages = 'kept';
  const pipeline = await pipelineService.ensureDefault(organizationId);
  if (untouched(pipeline)) {
    const byKind = new Map(pipeline.stages.map((stage) => [stage.kind, String(stage._id)]));
    const body = kit.stages.map((stage) => {
      const stageId = byKind.get(stage.kind);
      byKind.delete(stage.kind);
      return { ...(stageId && { id: stageId }), name: stage.name[lang], kind: stage.kind, probability: stage.probability, quietDays: stage.quietDays };
    });
    await pipelineService.update(req, pipeline._id, { stages: body });
    stages = 'set';
  }

  // The quick replies whose shortcut is still free.
  const taken = new Set((await QuickReply.find({ organizationId }).select('shortcut').lean()).map((reply) => reply.shortcut));
  let added = 0;
  for (const reply of kit.quickReplies) {
    if (taken.has(reply.shortcut)) continue;
    try {
      await quickReplyService.create(req, { shortcut: reply.shortcut, title: reply.title[lang], body: reply.body[lang] });
      added += 1;
    } catch (error) {
      if (error.code !== 'DUPLICATE_SHORTCUT') throw error; // made by someone else meanwhile: theirs stays
    }
  }

  // The quotation terms, when the company has none yet (with how long a quotation is valid).
  let terms = 'kept';
  if (!(await organizationService.getBilling(req)).terms.trim()) {
    await organizationService.setBilling(req, { terms: kit.terms[lang], validityDays: kit.validityDays });
    terms = 'set';
  }

  await Organization.updateOne({ _id: organizationId }, { $set: { 'onboarding.kit': id, 'onboarding.kitAt': new Date() } });
  const result = { kit: id, language: lang, stages, quickReplies: { added, kept: kit.quickReplies.length - added }, terms };
  await audit(req, { action: 'onboarding.kit_applied', entityType: 'Organization', entityId: organizationId, changes: result });
  return result;
}

module.exports = { status, setHidden, kits, applyKit };
