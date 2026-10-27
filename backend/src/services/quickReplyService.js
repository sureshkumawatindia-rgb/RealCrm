const QuickReply = require('../models/QuickReply');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { can } = require('../constants/permissions');
const { OPEN_STAGES } = require('../constants/crm');
const { visibilityFilter, privacyFilter } = require('./access');
const customFieldService = require('./customFieldService');

// Saved answers shared by the organization's inbox ("/price" → "Cumin 1kg is ₹250 + GST ...").
function serializeQuickReply(reply) {
  return { id: reply._id, shortcut: reply.shortcut, title: reply.title, body: reply.body, updatedAt: reply.updatedAt };
}

const duplicate = () => httpError(409, 'DUPLICATE_SHORTCUT', 'Another quick reply already uses this shortcut.');

async function findInOrg(req, id) {
  const reply = await QuickReply.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!reply) throw httpError(404, 'NOT_FOUND', 'Quick reply not found');
  return reply;
}

async function list(req) {
  const replies = await QuickReply.find({ organizationId: req.tenant.organizationId }).sort({ shortcut: 1 }).limit(500);
  return replies.map(serializeQuickReply);
}

async function create(req, body) {
  try {
    const reply = await QuickReply.create({ ...body, organizationId: req.tenant.organizationId, createdByMemberId: req.member._id });
    await audit(req, { action: 'quickreply.created', entityType: 'QuickReply', entityId: reply._id });
    return serializeQuickReply(reply);
  } catch (error) {
    if (error.code === 11000) throw duplicate();
    throw error;
  }
}

async function update(req, id, body) {
  const reply = await findInOrg(req, id);
  Object.assign(reply, body);
  try {
    await reply.save();
  } catch (error) {
    if (error.code === 11000) throw duplicate();
    throw error;
  }
  await audit(req, { action: 'quickreply.updated', entityType: 'QuickReply', entityId: reply._id, changes: Object.keys(body) });
  return serializeQuickReply(reply);
}

async function remove(req, id) {
  const reply = await findInOrg(req, id);
  await reply.deleteOne();
  await audit(req, { action: 'quickreply.deleted', entityType: 'QuickReply', entityId: reply._id });
}

// The customer's newest open lead this member may open, else their newest one; none when the
// member cannot open leads at all.
async function leadFor(req, contactId) {
  if (!['leads', 'deals'].some((module) => can(req.member, module, 'view'))) return null;
  const base = { organizationId: req.tenant.organizationId, contactId, ...visibilityFilter(req, ['leads', 'deals']), ...privacyFilter(req) };
  return (await Lead.findOne({ ...base, stage: { $in: OPEN_STAGES } }).sort({ createdAt: -1 })) || Lead.findOne(base).sort({ createdAt: -1 });
}

// A quick reply picked in a chat (D99): {{contact.name}}, {{lead.title}}, {{contact.cf.<key>}} …
// filled with that chat's customer, as this member sees them. A field hidden from them (D77), a
// lead or customer page they may not open, or a number hidden from agents (D65) stays empty and
// is named in `missing`, so they can look before sending.
async function fill(req, id, { conversationId }) {
  // Loaded here: both use many services.
  const conversationService = require('./conversationService'); // eslint-disable-line global-require
  const { fill: fillText, placeholdersIn } = require('./automation/actions'); // eslint-disable-line global-require
  const reply = await findInOrg(req, id);
  const conversation = await conversationService.findVisible(req, conversationId);
  const organizationId = req.tenant.organizationId;
  const [contact, lead, organization] = await Promise.all([
    Contact.findOne({ _id: conversation.contactId, organizationId }),
    leadFor(req, conversation.contactId),
    Organization.findById(organizationId).select('name'),
  ]);
  const seesCustomers = can(req.member, 'customers', 'view');
  const [owner, contactTexts, leadTexts] = await Promise.all([
    lead?.ownerId ? OrganizationMember.findById(lead.ownerId).populate('userId', 'name') : null,
    contact && seesCustomers ? customFieldService.displayTexts(req, 'contact', contact) : {},
    lead ? customFieldService.displayTexts(req, 'lead', lead) : {},
  ]);
  const ctx = {
    organization,
    contact: contact && { name: contact.name, company: contact.company, city: contact.city, phone: req.maskPhones ? '' : contact.phoneE164 || contact.phone || '' },
    lead,
    ownerName: owner?.displayName || owner?.userId?.name || '',
    fieldTexts: { contact: contactTexts, lead: leadTexts },
  };
  const missing = [...new Set(placeholdersIn(reply.body).filter((placeholder) => !fillText(placeholder, ctx).trim()))];
  return { text: fillText(reply.body, ctx), missing };
}

module.exports = { list, create, update, remove, fill, serializeQuickReply };
