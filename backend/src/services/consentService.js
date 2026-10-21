const ConsentEvent = require('../models/ConsentEvent');
const logger = require('../config/logger');

// Consent history (Phase 2, D79): every change of a customer's WhatsApp marketing consent is
// kept with how and by whom. A "change" to the same state is not a change and is not kept.

// Who made a change in a request: a teammate, or the API key's name ("… (API key "Zapier")").
const actorOf = (req) => ({ memberId: req?.member?._id, actorName: req?.user?.name || req?.user?.email || '' });
// The method of a change made in a request: through an API key, or by hand in the CRM.
const methodOf = (req) => (req?.apiKey ? 'api' : 'manual');

async function record({ organizationId, contactId, from = 'unknown', to, method, memberId, actorName = '', detail = '', at = new Date(), session }) {
  const before = from || 'unknown';
  if (!to || before === to) return null;
  try {
    const [event] = await ConsentEvent.create([{ organizationId, contactId, from: before, to, method, memberId, actorName, detail: String(detail || '').slice(0, 500), at }], { session });
    return event;
  } catch (error) {
    // The change itself is saved; a lost history entry is logged, not a reason to undo it.
    logger.error(`Consent history for contact ${contactId} could not be saved: ${error.message}`);
    return null;
  }
}

// Many at once (an import): the same change for each customer.
async function recordMany(organizationId, contactIds, { from = 'unknown', to, method, memberId, actorName = '', at = new Date() }) {
  if (!contactIds.length || from === to) return;
  try {
    await ConsentEvent.insertMany(contactIds.map((contactId) => ({ organizationId, contactId, from, to, method, memberId, actorName, at })), { ordered: false });
  } catch (error) {
    logger.error(`Consent history for an import could not be saved: ${error.message}`);
  }
}

const serialize = (e) => ({ id: e._id, channel: e.channel, from: e.from, to: e.to, method: e.method, actorName: e.actorName || '', detail: e.detail || '', at: e.at });

// GET /contacts/:id/consent-history (the caller has checked the member may see the customer).
async function history(req, contact) {
  const items = await ConsentEvent.find({ organizationId: req.tenant.organizationId, contactId: contact._id }).sort({ at: -1, _id: -1 }).limit(100);
  return items.map(serialize);
}

module.exports = { record, recordMany, history, actorOf, methodOf, serialize };
