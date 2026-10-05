const Contact = require('../../models/Contact');
const Conversation = require('../../models/Conversation');
const LeadActivity = require('../../models/LeadActivity');
const Organization = require('../../models/Organization');
const logger = require('../../config/logger');
const conversations = require('../conversationService');
const { leadOfContact } = require('./context');

// WhatsApp opt-out and opt-in (Phase 7, D35). A message that is only STOP / UNSUBSCRIBE (or the
// "Stop promotions" button of a marketing template) opts the customer out of broadcasts and
// marketing templates; START / SUBSCRIBE opts them back in. The customer gets a short
// confirmation, and the bot does not also answer that message.
const STOP = ['stop', 'unsubscribe', 'stop promotions', 'stop all', 'opt out', 'optout'];
const START = ['start', 'subscribe', 'unstop', 'opt in', 'optin'];
const CONFIRM = {
  opted_out: 'You will not get offers from {org} on WhatsApp any more. Reply START to get them again.',
  opted_in: 'Thank you! You will get offers from {org} on WhatsApp again. Reply STOP any time to stop them.',
};

// The whole message, without punctuation or emoji around it, in small letters.
const normalize = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

function wantsOf(text) {
  const words = normalize(text);
  if (STOP.includes(words)) return 'opted_out';
  if (START.includes(words)) return 'opted_in';
  return null;
}

// → 'opted_out' | 'opted_in' | null (not a consent message).
async function handleMessage(event) {
  if (event.type !== 'message.received' || !event.contactId) return null;
  const wants = wantsOf(event.text);
  if (!wants) return null;
  try {
    const contact = await Contact.findOneAndUpdate(
      { _id: event.contactId, organizationId: event.organizationId },
      { $set: { 'consent.marketing': wants, 'consent.changedAt': new Date(), 'consent.method': 'whatsapp_reply' } },
      { returnDocument: 'after' },
    );
    if (!contact) return null;
    const lead = await leadOfContact(event.organizationId, contact._id);
    if (lead) {
      await LeadActivity.create({
        organizationId: lead.organizationId, leadId: lead._id, contactId: contact._id, type: 'Consent', actorName: 'WhatsApp',
        text: wants === 'opted_out' ? 'Opted out of WhatsApp offers (replied STOP).' : 'Opted in to WhatsApp offers again (replied START).',
      });
    }
    const conversation = event.conversationId ? await Conversation.findOne({ _id: event.conversationId, organizationId: event.organizationId }) : null;
    if (conversation && conversations.serviceWindow(conversation).open) {
      const organization = await Organization.findById(event.organizationId).select('name');
      const text = CONFIRM[wants].replace('{org}', organization?.name || 'us');
      await conversations.sendTextAutomatically({ conversation, text, automation: { kind: 'consent' } });
    }
  } catch (error) {
    logger.error(`Consent update failed for contact ${event.contactId}: ${error.message}`);
  }
  return wants;
}

module.exports = { handleMessage, wantsOf, STOP, START };
