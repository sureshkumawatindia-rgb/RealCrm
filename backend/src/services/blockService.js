const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const ScheduledMessage = require('../models/ScheduledMessage');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const logger = require('../config/logger');
const { audit } = require('../utils/audit');
const { providerFor } = require('../integrations/whatsapp');
const { credentials } = require('./whatsappAccountService');

// Blocking a customer who spams or abuses (D103), from the chat. In the CRM: nothing can be sent
// to them (by a teammate or an automation), their messages still arrive but start no automation,
// bot, auto-reply or lead, broadcasts and new enquiries leave them out, their chats move to the
// "Blocked" list, and texts scheduled for them are cancelled. On WhatsApp too, where Meta allows
// it (Cloud API block_users, read 2026-10-29: only someone who wrote in the last 24 hours, per
// number; the docs say nothing about WhatsApp Business app numbers, so the CRM tries and keeps
// Meta's answer). Unblocking undoes both. Both are in the audit log.
const conversations = () => require('./conversationService'); // eslint-disable-line global-require -- it uses this service

// Every number the customer chats with: { ok, note } (note: why WhatsApp did not take it).
async function onWhatsApp(contact, { unblock = false } = {}) {
  const user = contact.phoneE164 ? contact.phoneE164.slice(1) : '';
  if (!user) return { ok: false, note: 'No WhatsApp number.' };
  const accountIds = await Conversation.distinct('whatsappAccountId', { organizationId: contact.organizationId, contactId: contact._id });
  const accounts = await WhatsAppAccount.find({ _id: { $in: accountIds }, organizationId: contact.organizationId });
  let ok = false;
  const notes = [];
  for (const account of accounts) {
    try {
      const result = await providerFor(account).blockUsers(credentials(account), [user], { unblock });
      if (result.done.length) ok = true;
      else notes.push(result.failed[0]?.errors?.[0]?.message || 'WhatsApp did not take it.');
    } catch (error) {
      logger.warn(`WhatsApp ${unblock ? 'unblock' : 'block'} for contact ${contact._id} refused: ${error.message}`);
      notes.push(error.message);
    }
  }
  return { ok, note: ok ? '' : notes[0] || 'There is no WhatsApp chat with this customer yet.' };
}

function serializeBlock(contact) {
  const b = contact.blocked;
  return b?.at
    ? { at: b.at, byName: b.byName || '', reason: b.reason || '', onWhatsApp: Boolean(b.onWhatsApp), whatsappNote: b.whatsappNote || '' }
    : null;
}

async function announceChats(organizationId, contactId) {
  const chats = await Conversation.find({ organizationId, contactId });
  for (const chat of chats) conversations().announce('conversation:updated', chat);
}

// POST /conversations/:id/block { reason? } — the chat's customer.
async function block(req, conversationId, { reason = '' } = {}) {
  const conversation = await conversations().findVisible(req, conversationId);
  const { organizationId } = conversation;
  const contact = await Contact.findOne({ _id: conversation.contactId, organizationId });
  if (contact && !contact.blocked?.at) {
    const meta = await onWhatsApp(contact);
    const at = new Date();
    contact.blocked = {
      at, byMemberId: req.member._id, byName: req.user.name || '', reason: String(reason).trim(), onWhatsApp: meta.ok, whatsappNote: meta.note,
    };
    await contact.save();
    await Conversation.updateMany({ organizationId, contactId: contact._id }, { $set: { blockedAt: at } });
    await ScheduledMessage.updateMany({ organizationId, contactId: contact._id, status: 'scheduled' }, { $set: { status: 'cancelled', error: 'The customer was blocked.', doneAt: at } });
    await audit(req, { action: 'contact.blocked', entityType: 'Contact', entityId: contact._id, changes: { reason: contact.blocked.reason, onWhatsApp: meta.ok, whatsappNote: meta.note } });
    await announceChats(organizationId, contact._id);
  }
  return { blocked: contact ? serializeBlock(contact) : null, conversation: await conversations().get(req, conversationId) };
}

// DELETE /conversations/:id/block
async function unblock(req, conversationId) {
  const conversation = await conversations().findVisible(req, conversationId);
  const { organizationId } = conversation;
  const contact = await Contact.findOne({ _id: conversation.contactId, organizationId });
  if (contact?.blocked?.at) {
    const meta = contact.blocked.onWhatsApp ? await onWhatsApp(contact, { unblock: true }) : { ok: false, note: '' };
    contact.blocked = undefined;
    await contact.save();
    await Conversation.updateMany({ organizationId, contactId: contact._id }, { $unset: { blockedAt: 1 } });
    await audit(req, { action: 'contact.unblocked', entityType: 'Contact', entityId: contact._id, changes: { onWhatsApp: meta.ok, whatsappNote: meta.note } });
    await announceChats(organizationId, contact._id);
  }
  return { blocked: null, conversation: await conversations().get(req, conversationId) };
}

// GET /conversations/:id/block — whether the chat's customer is blocked, and by whom.
async function status(req, conversationId) {
  const conversation = await conversations().findVisible(req, conversationId);
  const contact = await Contact.findOne({ _id: conversation.contactId, organizationId: conversation.organizationId }).select('blocked');
  return { blocked: contact ? serializeBlock(contact) : null };
}

module.exports = { block, unblock, status, serializeBlock, onWhatsApp };
