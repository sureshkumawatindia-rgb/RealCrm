const Contact = require('../../models/Contact');
const Conversation = require('../../models/Conversation');
const Lead = require('../../models/Lead');
const Order = require('../../models/Order');
const Organization = require('../../models/Organization');
const OrganizationMember = require('../../models/OrganizationMember');
const Quotation = require('../../models/Quotation');
const Task = require('../../models/Task');
const { OPEN_STAGES } = require('../../constants/crm');

// What workflow runs and sequence steps work on (Phase 6): the records loaded fresh for each
// step, and the request-like object their actions change records with.

async function loadContext({ organizationId, subject = {}, event = {} }) {
  const byId = (Model, id) => (id ? Model.findOne({ _id: id, organizationId }) : null);
  const [lead, order, quotation, task, conversation, organization] = await Promise.all([
    byId(Lead, subject.leadId), byId(Order, subject.orderId), byId(Quotation, subject.quotationId), byId(Task, subject.taskId),
    byId(Conversation, subject.conversationId), Organization.findById(organizationId),
  ]);
  const contactId = subject.contactId || lead?.contactId || order?.contactId || quotation?.contactId || conversation?.contactId;
  const contact = contactId ? await Contact.findOne({ _id: contactId, organizationId }) : null;
  const owner = lead?.ownerId ? await OrganizationMember.findById(lead.ownerId).populate('userId', 'name') : null;
  return { organization, lead, contact, order, quotation, task, conversation, event, ownerName: owner?.displayName || owner?.userId?.name || '' };
}

// The newest open lead of a customer (else their newest lead).
async function leadOfContact(organizationId, contactId) {
  if (!contactId) return null;
  return (await Lead.findOne({ organizationId, contactId, stage: { $in: OPEN_STAGES } }).sort({ createdAt: -1 }))
    || Lead.findOne({ organizationId, contactId }).sort({ createdAt: -1 });
}

// run: { _id, organizationId, chain }; source: the workflow or sequence ({ _id, name, actorName? }).
function systemReq(run, source) {
  return {
    tenant: { organizationId: run.organizationId },
    member: { _id: undefined, role: 'owner', modules: [], permissions: [], status: 'active' },
    user: { _id: undefined, name: source.actorName || `Automation "${source.name}"` },
    automation: { runId: run._id, chain: [...(run.chain || []).map(String), String(source._id)] },
    id: `automation:${run._id}`,
    ip: '',
    get: () => '',
  };
}

module.exports = { loadContext, leadOfContact, systemReq };
