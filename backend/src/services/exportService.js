const { once } = require('events');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Contact = require('../models/Contact');
const Product = require('../models/Product');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Quotation = require('../models/Quotation');
const Order = require('../models/Order');
const Task = require('../models/Task');
const CalendarEvent = require('../models/CalendarEvent');
const Ticket = require('../models/Ticket');
const Note = require('../models/Note');
const Document = require('../models/Document');
const Campaign = require('../models/Campaign');
const Workflow = require('../models/Workflow');
const Sequence = require('../models/Sequence');
const PaymentLink = require('../models/PaymentLink');
const { audit } = require('../utils/audit');
const { indiaDate } = require('../utils/dates');

// "Download CRM data": one JSON file with all of the organization's data (Phase 10F: every
// section of the CRM, for backups, for moving to another system, and for a company that asked
// to be deleted). Deleted records, secrets (keys, tokens, hashes, sessions, Gmail) and internal
// fields are left out; stored files are listed but not included (download them from Documents
// or the chat).
const model = (name) => require(`../models/${name}`); // eslint-disable-line global-require, import/no-dynamic-require
const SECTIONS = [
  ['contacts', Contact], ['products', Product], ['leads', Lead], ['leadActivities', LeadActivity],
  ['quotations', Quotation], ['orders', Order], ['tasks', Task], ['events', CalendarEvent], ['tickets', Ticket], ['notes', Note],
  ['documents', Document], ['campaigns', Campaign], ['workflows', Workflow], ['sequences', Sequence], ['paymentLinks', PaymentLink],
  // WhatsApp and the inbox
  ['whatsappNumbers', model('WhatsAppAccount')], ['conversations', model('Conversation')], ['messages', model('Message')],
  ['quickReplies', model('QuickReply')], ['messageTemplates', model('MessageTemplate')],
  // Lead sources and routing
  ['leadSources', model('LeadSourceConnection')], ['leadIntakes', model('LeadIntake')], ['assignmentRules', model('AssignmentRule')],
  ['assignmentHistory', model('AssignmentHistory')], ['autoReplyRules', model('AutoReplyRule')],
  // Automation, the FAQ bot, marketing
  ['faqAnswers', model('FaqRule')], ['botSettings', model('BotSettings')], ['sequenceEnrollments', model('SequenceEnrollment')],
  ['automationRuns', model('AutomationRun')], ['segments', model('Segment')], ['broadcasts', model('Broadcast')], ['broadcastRecipients', model('BroadcastRecipient')],
  // Payments, the plan and integrations
  ['paymentGateways', model('PaymentConnection')], ['planInvoices', model('BillingInvoice')], ['apiKeys', model('ApiKey')],
  ['webhooks', model('WebhookSubscription')], ['metaConversionsApi', model('ConversionsApiConnection')], ['aiUsage', model('AiUsage')],
  ['auditLog', model('AuditLog')],
];
// Never in the file: internal fields, and anything secret (encrypted keys and tokens, hashes,
// webhook keys, storage paths).
const HIDDEN_FIELDS = ['organizationId', '__v', 'deletedAt', 'storageKey', 'webhookSecret', 'webhookKey', 'hash', 'liveKey'];
const SECRET_FIELD = /(Enc|Hash)$|^encrypted/;

function clean(doc) {
  const copy = { ...doc };
  for (const field of Object.keys(copy)) if (HIDDEN_FIELDS.includes(field) || SECRET_FIELD.test(field)) delete copy[field];
  return copy;
}

function teamEntry(member) {
  return {
    id: member._id,
    name: member.displayName || member.userId?.name || '',
    email: member.userId?.email || '',
    role: member.role,
    title: member.title,
    mobile: member.mobile,
    modules: member.modules,
    permissions: member.permissions,
    status: member.status,
    joinedAt: member.createdAt,
  };
}

// Waits when the connection's buffer is full; false once the client has gone away.
async function send(res, chunk) {
  if (res.destroyed) return false;
  if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
  return !res.destroyed;
}

// Streams the file section by section, so a big organization never has to fit in memory.
async function streamExport(req, res) {
  const { organizationId } = req.tenant;
  const [organization, members] = await Promise.all([
    Organization.findById(organizationId).lean(),
    OrganizationMember.find({ organizationId }).populate({ path: 'userId', select: 'name email' }).lean(),
  ]);
  await audit(req, { action: 'export.crm', entityType: 'Organization', entityId: organizationId });

  res.attachment(`crm-export-${indiaDate()}.json`);
  res.type('application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    await send(res, `{"format":"yellow-crm-export","version":2,"exportedAt":${JSON.stringify(new Date())}`);
    await send(res, `,"organization":${JSON.stringify(clean(organization || {}))}`);
    await send(res, `,"team":${JSON.stringify(members.map(teamEntry))}`);
    for (const [name, Model] of SECTIONS) {
      if (!(await send(res, `,${JSON.stringify(name)}:[`))) return;
      let first = true;
      // deletedAt: null also matches collections without soft delete (the field is missing).
      for await (const doc of Model.find({ organizationId, deletedAt: null }).sort({ _id: 1 }).lean().cursor()) {
        if (!(await send(res, `${first ? '' : ','}${JSON.stringify(clean(doc))}`))) return;
        first = false;
      }
      await send(res, ']');
    }
    res.end('}');
  } catch (error) {
    // Headers are already sent: cut the download so a half file is never taken for a whole one.
    res.destroy(error);
  }
}

module.exports = { streamExport, SECTIONS };
