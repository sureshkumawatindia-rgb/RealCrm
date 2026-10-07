const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const LeadIntake = require('../models/LeadIntake');
const LeadSourceConnection = require('../models/LeadSourceConnection');
const Product = require('../models/Product');
const bus = require('../realtime/bus');
const automationEvents = require('./automation/events');
const logger = require('../config/logger');
const { normalizePhone } = require('../utils/phone');
const { OPEN_STAGES, STAGE_PROBABILITY } = require('../constants/crm');
const { RAW_PAYLOAD_MAX_BYTES } = require('../constants/leadSources');

// Every lead source (website form, IndiaMART, Facebook, …) ends here: one enquiry becomes a
// Contact + Lead with source, sourceRef and the raw payload.
// - The same enquiry (organization + source + sourceRef) is taken only once.
// - Contacts are deduplicated by phone (E.164, +91 by default), else by email.
// - D26: if the contact already has an open lead, the enquiry is added to it (an activity, and
//   the follow-up moves to now) instead of a second lead.
// Emits "lead:intake" for assignment and auto-reply rules.
const str = (value, max = 500) => (value == null ? '' : String(value).trim().slice(0, max));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Keeps the raw payload for troubleshooting, but never more than the size limit.
function capRaw(raw) {
  if (raw == null) return undefined;
  try {
    const text = JSON.stringify(raw);
    if (Buffer.byteLength(text) <= RAW_PAYLOAD_MAX_BYTES) return raw;
    return { truncated: true, text: text.slice(0, RAW_PAYLOAD_MAX_BYTES) };
  } catch {
    return { unreadable: true };
  }
}

// One line for the lead timeline and the intake log.
function describe(source, enquiry) {
  const parts = [];
  if (enquiry.product) parts.push(enquiry.product);
  if (enquiry.quantity) parts.push(`qty ${enquiry.quantity}`);
  const head = `${source} enquiry${parts.length ? `: ${parts.join(' · ')}` : ''}`;
  return str(enquiry.message ? `${head} — ${enquiry.message}` : head, 2000);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function productNamed(organizationId, name) {
  if (!name) return null;
  return Product.findOne({ organizationId, name: new RegExp(`^${escapeRegExp(name)}$`, 'i') }).select('_id');
}

// Finds the contact by phone (else email) or creates it; blank fields of an existing contact
// are filled in, nothing is overwritten.
async function findOrCreateContact(organizationId, source, sourceRef, person) {
  const { phoneE164, email } = person;
  const existing = phoneE164
    ? await Contact.findOne({ organizationId, phoneE164 })
    : await Contact.findOne({ organizationId, email });
  const details = {
    name: str(person.name, 200), email, company: str(person.company, 200), city: str(person.city, 100),
    state: str(person.state, 100), address: str(person.address, 500),
  };
  if (existing) {
    const blanks = Object.fromEntries(Object.entries(details).filter(([key, value]) => value && !existing[key]));
    if (Object.keys(blanks).length) await Contact.updateOne({ _id: existing._id }, { $set: blanks });
    return { contact: existing, created: false };
  }
  try {
    const contact = await Contact.create({
      organizationId, ...details, name: details.name || phoneE164 || email,
      phone: phoneE164 || '', ...(phoneE164 && { phoneE164 }), source, sourceRef, lifecycle: 'lead',
    });
    automationEvents.emit('contact.created', { organizationId, contactId: contact._id, source, key: `contact.created:${contact._id}` });
    return { contact, created: true };
  } catch (error) {
    if (error.code !== 11000) throw error; // the same number arrived twice at once
    return { contact: await Contact.findOne({ organizationId, phoneE164 }), created: false };
  }
}

async function countOutcome(connectionId, outcome) {
  if (!connectionId) return;
  await LeadSourceConnection.updateOne(
    { _id: connectionId },
    { $inc: { 'stats.received': 1, [`stats.${outcome}`]: 1 }, ...(outcome === 'created' || outcome === 'attached' ? { $set: { lastLeadAt: new Date() } } : {}) },
  );
}

/**
 * @param {object} input
 *   organizationId, source (LEAD_SOURCES), sourceRef (the source's own id for this enquiry),
 *   connectionId?, person { name, phone, email, company, city, state, address },
 *   enquiry { product, quantity, message }, raw (the payload as received), receivedAt?
 * @returns {{ outcome: 'created'|'attached'|'duplicate'|'rejected', leadId?, contactId?, contactCreated? }}
 */
async function intake({ organizationId, source, sourceRef, connectionId, person = {}, enquiry = {}, raw, receivedAt }) {
  const ref = str(sourceRef, 200);
  const summary = describe(source, { product: str(enquiry.product, 200), quantity: str(enquiry.quantity, 50), message: str(enquiry.message, 1500) });
  let record;
  try {
    record = await LeadIntake.create({ organizationId, source, sourceRef: ref, connectionId, raw: capRaw(raw), receivedAt: receivedAt || new Date(), summary });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await LeadIntake.findOne({ organizationId, source, sourceRef: ref });
    // A failed attempt may be tried again; anything else was already taken.
    if (existing.outcome !== 'failed') {
      await countOutcome(connectionId, 'duplicate');
      return { outcome: 'duplicate', leadId: existing.leadId || null, contactId: existing.contactId || null };
    }
    record = existing;
  }

  try {
    const phone = normalizePhone(person.phone);
    const email = str(person.email, 254).toLowerCase();
    const validEmail = EMAIL.test(email) ? email : '';
    if (!phone && !validEmail) {
      await LeadIntake.updateOne({ _id: record._id }, { $set: { outcome: 'rejected', reason: 'No valid mobile number or email', processedAt: new Date() } });
      await countOutcome(connectionId, 'rejected');
      return { outcome: 'rejected' };
    }

    const { contact, created: contactCreated } = await findOrCreateContact(organizationId, source, ref, { ...person, phoneE164: phone || null, email: validEmail });
    const now = new Date();
    // A retried enquiry may have created its lead before failing.
    const ownLead = await Lead.findOne({ organizationId, source, sourceRef: ref });
    const openLead = ownLead ? null : await Lead.findOne({ organizationId, contactId: contact._id, stage: { $in: OPEN_STAGES } }).sort({ createdAt: -1 });
    let lead;
    let outcome;
    if (ownLead) {
      outcome = 'created';
      lead = ownLead;
    } else if (openLead) {
      outcome = 'attached';
      lead = openLead;
      await Lead.updateOne({ _id: lead._id }, { $set: { followUpAt: now, lastActivityAt: now }, $inc: { version: 1 } });
      await LeadActivity.create({
        organizationId, leadId: lead._id, contactId: contact._id, type: 'Enquiry', text: summary, actorName: source, meta: { source, sourceRef: ref },
      });
    } else {
      outcome = 'created';
      const product = await productNamed(organizationId, str(enquiry.product, 200));
      const quantity = Number(enquiry.quantity);
      lead = await Lead.create({
        organizationId, contactId: contact._id, title: str(enquiry.product, 200) || `${source} enquiry`,
        stage: 'New', probability: STAGE_PROBABILITY.New, source, sourceRef: ref,
        ...(product && { productId: product._id }), ...(Number.isFinite(quantity) && quantity > 0 && { quantity }),
        notes: str(enquiry.message, 5000), followUpAt: now, stageChangedAt: now, lastActivityAt: now,
      });
      await LeadActivity.create({
        organizationId, leadId: lead._id, contactId: contact._id, type: 'Lead created', text: summary, actorName: source, meta: { source, sourceRef: ref },
      });
    }

    await LeadIntake.updateOne({ _id: record._id }, { $set: { outcome, reason: '', contactId: contact._id, leadId: lead._id, processedAt: now } });
    await countOutcome(connectionId, outcome);
    bus.emit('lead:intake', {
      organizationId, source, sourceRef: ref, connectionId: connectionId || null, leadId: lead._id, contactId: contact._id, outcome, contactCreated,
      receivedAt: record.receivedAt,
    });
    return { outcome, leadId: lead._id, contactId: contact._id, contactCreated };
  } catch (error) {
    logger.error(`Lead intake ${source}/${ref} failed: ${error.message}`);
    await LeadIntake.updateOne({ _id: record._id }, { $set: { outcome: 'failed', reason: str(error.message, 500) } });
    throw error;
  }
}

module.exports = { intake, describe, capRaw };
