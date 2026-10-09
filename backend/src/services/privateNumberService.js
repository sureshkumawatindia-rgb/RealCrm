const mongoose = require('mongoose');
const PrivateNumber = require('../models/PrivateNumber');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const httpError = require('../utils/httpError');
const bus = require('../realtime/bus');
const { audit } = require('../utils/audit');
const { normalizePhone } = require('../utils/phone');

// Private numbers (D61), owners only: personal chats (family, friends) that came in with the
// company's WhatsApp Business app number. Making a number private marks its contact, leads,
// chats and messages `private`: from then on only owners see them (access.privacyFilter, the
// owners' Socket.IO room), reports leave them out, and new messages from the number stay private
// and run no automation, bot, auto-reply, lead creation or notification
// (whatsappInboundService). Nothing is deleted; making it visible again undoes it all.

// "+919829020001" → "+91 ••••• 0001": what the audit log keeps (admins read it too).
const masked = (phoneE164) => `${phoneE164.slice(0, 3)} ••••• ${phoneE164.slice(-4)}`;

function phoneOf(raw) {
  const phoneE164 = normalizePhone(raw);
  if (!phoneE164) throw httpError(400, 'VALIDATION_ERROR', 'Enter a valid mobile number.', [{ field: 'phone', message: 'Enter a valid mobile number.' }]);
  return phoneE164;
}

async function isPrivate(organizationId, phoneE164) {
  return Boolean(phoneE164 && await PrivateNumber.exists({ organizationId, phoneE164 }));
}

// Marks (or unmarks) everything of this number. Soft-deleted contacts and leads too (through the
// driver, past the soft-delete filter), so nothing comes back visible if it is restored.
async function setFlag(organizationId, phoneE164, value) {
  const orgId = new mongoose.Types.ObjectId(String(organizationId));
  const contacts = await Contact.collection.find({ organizationId: orgId, phoneE164 }, { projection: { _id: 1 } }).toArray();
  const contactIds = contacts.map((contact) => contact._id);
  const change = value ? { $set: { private: true } } : { $unset: { private: '' } };
  const conversations = await Conversation.find({ organizationId: orgId, contactId: { $in: contactIds } }).select('_id').lean();
  await Promise.all([
    Contact.collection.updateMany({ _id: { $in: contactIds } }, change),
    Lead.collection.updateMany({ organizationId: orgId, contactId: { $in: contactIds } }, change),
    Conversation.updateMany({ _id: { $in: conversations.map((c) => c._id) } }, change),
    Message.updateMany({ organizationId: orgId, contactId: { $in: contactIds } }, change),
  ]);
  return { contacts: contactIds.length, chats: conversations.length };
}

async function serialize(entry) {
  const contact = await Contact.findOne({ organizationId: entry.organizationId, phoneE164: entry.phoneE164 }).select('name');
  const chats = contact ? await Conversation.countDocuments({ organizationId: entry.organizationId, contactId: contact._id }) : 0;
  return { id: entry._id, phone: entry.phoneE164, name: contact?.name || '', note: entry.note, chats, addedAt: entry.createdAt };
}

// GET /privacy/numbers
async function list(req) {
  const entries = await PrivateNumber.find({ organizationId: req.tenant.organizationId }).sort({ createdAt: -1 });
  return Promise.all(entries.map(serialize));
}

// POST /privacy/numbers { phone, note } — also before the number ever wrote (e.g. before
// connecting WhatsApp, so its history comes in private).
async function add(req, { phone, note = '' }) {
  const { organizationId } = req.tenant;
  const phoneE164 = phoneOf(phone);
  let entry = await PrivateNumber.findOne({ organizationId, phoneE164 });
  if (!entry) {
    try {
      entry = await PrivateNumber.create({ organizationId, phoneE164, note, addedById: req.member._id });
    } catch (error) {
      if (error.code !== 11000) throw error;
      entry = await PrivateNumber.findOne({ organizationId, phoneE164 });
    }
  } else if (note) {
    entry.note = note;
    await entry.save();
  }
  const counts = await setFlag(organizationId, phoneE164, true);
  await audit(req, { action: 'privacy.number_private', entityType: 'PrivateNumber', entityId: entry._id, changes: { phone: masked(phoneE164), ...counts } });
  // Teammates' open Inbox pages drop the chats at their next refresh; tell them now.
  bus.emit('privacy:changed', { organizationId });
  return serialize(entry);
}

// POST /conversations/:id/private { note } — "Make private" in a chat.
async function addFromConversation(req, conversationId, { note = '' } = {}) {
  const conversation = await Conversation.findOne({ _id: conversationId, organizationId: req.tenant.organizationId }).populate('contactId', 'phoneE164');
  if (!conversation) throw httpError(404, 'NOT_FOUND', 'Conversation not found');
  if (!conversation.contactId?.phoneE164) throw httpError(400, 'VALIDATION_ERROR', 'This chat has no phone number.');
  return add(req, { phone: conversation.contactId.phoneE164, note });
}

// DELETE /privacy/numbers/:id — visible to the team again (new messages run automations again).
async function remove(req, id) {
  const entry = await PrivateNumber.findOne({ _id: id, organizationId: req.tenant.organizationId });
  if (!entry) throw httpError(404, 'NOT_FOUND', 'This number is not private.');
  await PrivateNumber.deleteOne({ _id: entry._id });
  const counts = await setFlag(entry.organizationId, entry.phoneE164, false);
  await audit(req, { action: 'privacy.number_visible', entityType: 'PrivateNumber', entityId: entry._id, changes: { phone: masked(entry.phoneE164), ...counts } });
  bus.emit('privacy:changed', { organizationId: entry.organizationId });
  return { removed: true };
}

module.exports = { list, add, addFromConversation, remove, isPrivate, setFlag };
