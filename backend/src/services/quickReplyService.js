const QuickReply = require('../models/QuickReply');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');

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

module.exports = { list, create, update, remove, serializeQuickReply };
