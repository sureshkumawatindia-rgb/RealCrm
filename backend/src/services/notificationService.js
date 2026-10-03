const Notification = require('../models/Notification');
const OrganizationMember = require('../models/OrganizationMember');
const bus = require('../realtime/bus');
const httpError = require('../utils/httpError');

// The CRM's bell (Phase 6, D31): notifications for one member, shown live (Socket.IO for those
// with the inbox open) and on every page through GET /notifications.
function serialize(notification) {
  return {
    id: notification._id, title: notification.title, body: notification.body, link: notification.link,
    source: notification.source, readAt: notification.readAt || null, createdAt: notification.createdAt,
  };
}

// memberIds: who gets it (only active members of the organization).
async function notify(organizationId, memberIds, { title, body = '', link = '', source = '' }) {
  const members = await OrganizationMember.find({ _id: { $in: memberIds }, organizationId, status: 'active' }).select('_id');
  const created = [];
  for (const member of members) {
    const notification = await Notification.create({ organizationId, memberId: member._id, title: title.slice(0, 200), body: body.slice(0, 1000), link, source });
    bus.emit('notification:new', { organizationId, memberId: member._id, notification: serialize(notification) });
    created.push(notification);
  }
  return created;
}

async function list(req, { unread = false, limit = 20 } = {}) {
  const filter = { organizationId: req.tenant.organizationId, memberId: req.member._id, ...(unread && { readAt: null }) };
  const [items, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(limit),
    Notification.countDocuments({ organizationId: req.tenant.organizationId, memberId: req.member._id, readAt: null }),
  ]);
  return { items: items.map(serialize), unread: unreadCount };
}

async function markRead(req, id) {
  const notification = await Notification.findOneAndUpdate(
    { _id: id, organizationId: req.tenant.organizationId, memberId: req.member._id },
    { $set: { readAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!notification) throw httpError(404, 'NOT_FOUND', 'Notification not found');
  return serialize(notification);
}

async function markAllRead(req) {
  const result = await Notification.updateMany({ organizationId: req.tenant.organizationId, memberId: req.member._id, readAt: null }, { $set: { readAt: new Date() } });
  return { updated: result.modifiedCount };
}

module.exports = { notify, list, markRead, markAllRead, serialize };
