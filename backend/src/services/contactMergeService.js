const mongoose = require('mongoose');
const AiUsage = require('../models/AiUsage');
const AssignmentHistory = require('../models/AssignmentHistory');
const AutomationRun = require('../models/AutomationRun');
const BroadcastRecipient = require('../models/BroadcastRecipient');
const CalendarEvent = require('../models/CalendarEvent');
const Call = require('../models/Call');
const ChatResolution = require('../models/ChatResolution');
const ConsentEvent = require('../models/ConsentEvent');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const CustomFieldDefinition = require('../models/CustomFieldDefinition');
const CustomRecord = require('../models/CustomRecord');
const DialerSession = require('../models/DialerSession');
const Document = require('../models/Document');
const EmailMessage = require('../models/EmailMessage');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const LeadIntake = require('../models/LeadIntake');
const Message = require('../models/Message');
const Note = require('../models/Note');
const Order = require('../models/Order');
const OrganizationMember = require('../models/OrganizationMember');
const PaymentLink = require('../models/PaymentLink');
const Project = require('../models/Project');
const Quotation = require('../models/Quotation');
const SequenceEnrollment = require('../models/SequenceEnrollment');
const SmsMessage = require('../models/SmsMessage');
const Task = require('../models/Task');
const Ticket = require('../models/Ticket');
const Touchpoint = require('../models/Touchpoint');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const contactService = require('./contactService');
const customFieldService = require('./customFieldService');
const consentService = require('./consentService');
const automationEvents = require('./automation/events');

// Possible duplicate customers, and merging two into one (D100; owners and admins). The customer
// kept ("main") takes the values picked field by field; everything the other one had — leads,
// chats and their messages, quotations, orders, payments, tickets, tasks, meetings, documents,
// notes, calls, SMS, emails, sequences, projects, records, history — moves to it, in one
// transaction, and the other is deleted. Two chats on the same WhatsApp number become one.
// Private numbers (D61) are never merged. It cannot be undone.

const FIELDS = [
  ['name', 'Name'], ['email', 'Email'], ['phone', 'Mobile'], ['company', 'Company'], ['gstin', 'GSTIN'],
  ['city', 'City'], ['state', 'State'], ['address', 'Address'], ['ownerId', 'Owner'], ['status', 'Status'],
];
const MAX_GROUPS = 100;
const blank = (value) => value === undefined || value === null || (typeof value === 'string' && !value.trim());
const tenDigits = (contact) => {
  const digits = String(contact.phoneE164 || contact.phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
};
const phoneOf = (contact) => contact.phoneE164 || contact.phone || '';
const CONSENT_RANK = { opted_out: 2, opted_in: 1, unknown: 0 };

// --- possible duplicates ----------------------------------------------------------------------

async function countBy(Model, organizationId, ids, field = 'contactId') {
  const rows = await Model.aggregate([{ $match: { organizationId, [field]: { $in: ids } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
  return new Map(rows.map((row) => [String(row._id), row.n]));
}

// GET /contacts/duplicates — customers sharing a mobile number (last 10 digits), an email or a
// GSTIN, newest first. A group shared for several reasons is listed once with all of them.
async function duplicates(req) {
  const organizationId = req.tenant.organizationId;
  const contacts = await Contact.find({ organizationId, private: { $ne: true } })
    .select('name email phone phoneE164 gstin company city lifecycle createdAt').lean();
  const keyOf = {
    phone: tenDigits,
    email: (c) => String(c.email || '').trim().toLowerCase(),
    gstin: (c) => String(c.gstin || '').trim().toUpperCase(),
  };
  const groups = new Map();
  for (const [reason, read] of Object.entries(keyOf)) {
    const buckets = new Map();
    for (const contact of contacts) {
      const key = read(contact);
      if (!key) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(String(contact._id));
    }
    for (const [value, ids] of buckets) {
      if (ids.length < 2) continue;
      const sorted = [...ids].sort();
      const id = sorted.join(',');
      if (!groups.has(id)) groups.set(id, { ids: sorted, reasons: [] });
      groups.get(id).reasons.push({ reason, value });
    }
  }
  const byId = new Map(contacts.map((c) => [String(c._id), c]));
  const newest = (group) => Math.max(...group.ids.map((id) => new Date(byId.get(id).createdAt).getTime()));
  const list = [...groups.values()].sort((a, b) => newest(b) - newest(a)).slice(0, MAX_GROUPS);
  const ids = [...new Set(list.flatMap((group) => group.ids))].map((id) => new mongoose.Types.ObjectId(id));
  const [leads, chats, orders] = await Promise.all([countBy(Lead, organizationId, ids), countBy(Conversation, organizationId, ids), countBy(Order, organizationId, ids)]);
  return {
    total: groups.size,
    groups: list.map((group) => ({
      reasons: group.reasons,
      contacts: group.ids.map((id) => byId.get(id)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).map((c) => ({
        id: String(c._id), name: c.name, email: c.email || '', phone: phoneOf(c), company: c.company || '', gstin: c.gstin || '', city: c.city || '',
        lifecycle: c.lifecycle, createdAt: c.createdAt, leads: leads.get(String(c._id)) || 0, chats: chats.get(String(c._id)) || 0, orders: orders.get(String(c._id)) || 0,
      })),
    })),
  };
}

// --- the pair ------------------------------------------------------------------------------------

async function pairOf(req, mainId, otherId, session) {
  if (String(mainId) === String(otherId)) throw httpError(400, 'VALIDATION_ERROR', 'Pick two different customers.', [{ field: 'otherId', code: 'SAME_CONTACT', message: 'Pick two different customers.' }]);
  const main = await contactService.findVisible(req, mainId, session);
  const other = await contactService.findVisible(req, otherId, session);
  if (main.private || other.private) throw httpError(409, 'PRIVATE', 'A private number cannot be merged.');
  return { main, other };
}

// What moves from the other customer to the one kept (also counted for the preview).
const MOVES = [
  ['leads', Lead], ['quotations', Quotation], ['orders', Order], ['paymentLinks', PaymentLink], ['tickets', Ticket], ['calls', Call],
  ['sms', SmsMessage], ['projects', Project], ['records', CustomRecord], ['touchpoints', Touchpoint], ['consentEvents', ConsentEvent],
  ['leadActivities', LeadActivity], ['enquiries', LeadIntake], ['assignments', AssignmentHistory], ['messages', Message],
];
const RELATED = [['tasks', Task], ['events', CalendarEvent], ['documents', Document]];
const relatedTo = (id) => ({ relatedType: { $in: ['Customer', 'Contact'] }, relatedId: id });

async function countsOf(organizationId, otherId, mainId) {
  const O = { organizationId };
  const counts = {};
  for (const [name, Model] of MOVES) counts[name] = await Model.collection.countDocuments({ ...O, contactId: otherId });
  for (const [name, Model] of RELATED) counts[name] = await Model.collection.countDocuments({ ...O, ...relatedTo(otherId) });
  counts.notes = await Note.collection.countDocuments({ ...O, parentType: 'contact', parentId: otherId });
  counts.emails = await EmailMessage.collection.countDocuments({ ...O, contactIds: otherId });
  counts.sequences = await SequenceEnrollment.collection.countDocuments({ ...O, contactId: otherId });
  const [mainChats, otherChats] = await Promise.all([
    Conversation.find({ ...O, contactId: mainId }).select('whatsappAccountId').lean(),
    Conversation.find({ ...O, contactId: otherId }).select('whatsappAccountId').lean(),
  ]);
  const accounts = new Set(mainChats.map((c) => String(c.whatsappAccountId)));
  // chats: those that move as they are; chatsJoined: those that join the kept one's chat.
  counts.chatsJoined = otherChats.filter((c) => accounts.has(String(c.whatsappAccountId))).length;
  counts.chats = otherChats.length - counts.chatsJoined;
  return counts;
}

// --- the preview -------------------------------------------------------------------------------

// GET /contacts/:id/merge-preview?with=<otherId> — both customers' values side by side (the
// company's own fields too), what would move, and what to look out for.
async function preview(req, mainId, otherId) {
  const { main, other } = await pairOf(req, mainId, otherId);
  const organizationId = req.tenant.organizationId;
  const members = new Map((await OrganizationMember.find({ organizationId }).populate('userId', 'name').lean())
    .map((m) => [String(m._id), m.displayName || m.userId?.name || '']));
  const show = (contact, key) => {
    if (key === 'phone') return phoneOf(contact);
    if (key === 'ownerId') return contact.ownerId ? members.get(String(contact.ownerId)) || '' : '';
    return contact[key] || '';
  };
  const rows = FIELDS.map(([key, label]) => ({ key, label, main: show(main, key), other: show(other, key) }));
  const fields = (await customFieldService.fieldsFor(req, 'contact')).filter((field) => field.status === 'active').sort((a, b) => a.order - b.order);
  const lookupService = require('./lookupService'); // eslint-disable-line global-require
  const links = await lookupService.linksFor(req, 'contact', [main, other]);
  for (const field of fields) {
    const text = (contact) => customFieldService.displayText(field, contact.customFields?.[field.key], links.get(String(contact._id))?.[field.key]);
    rows.push({ key: `cf.${field.key}`, label: field.label, main: text(main), other: text(other) });
  }
  const differentPhones = Boolean(main.phoneE164 && other.phoneE164 && main.phoneE164 !== other.phoneE164);
  return {
    main: { id: String(main._id), name: main.name },
    other: { id: String(other._id), name: other.name },
    fields: rows.filter((row) => row.main || row.other).map((row) => ({ ...row, same: row.main === row.other, default: row.main ? 'main' : 'other' })),
    moves: await countsOf(organizationId, other._id, main._id),
    differentPhones,
  };
}

// --- the merge ------------------------------------------------------------------------------------

// The kept customer's values: each field from the side picked (keep[key] = "main" | "other"),
// else the main one's, or the other's when the main one has none. Tags, products and old ids
// are joined; the stricter consent, the earliest first touch and the latest call are kept; a
// number or email that is not kept goes into the notes, so nothing is lost.
function finalValues(main, other, keep) {
  const sideOf = (key) => (keep[key] === 'other' ? other : keep[key] === 'main' ? main : null);
  const pick = (key, read = (c) => c[key]) => {
    const side = sideOf(key);
    if (side) return read(side);
    return blank(read(main)) ? read(other) : read(main);
  };
  const phoneSide = sideOf('phone') || (main.phoneE164 || blank(phoneOf(other)) ? main : other);
  const gstinSide = sideOf('gstin') || (blank(main.gstin) ? other : main);
  const values = {
    name: pick('name') || main.name,
    email: pick('email') || '',
    phone: phoneSide.phone || '',
    phoneE164: phoneSide.phoneE164 || undefined,
    gstin: gstinSide.gstin || '',
    stateCode: gstinSide.stateCode || '',
    company: pick('company') || '',
    city: pick('city') || '',
    state: pick('state') || '',
    address: pick('address') || '',
    status: pick('status') || main.status,
    ownerId: pick('ownerId') || undefined,
  };
  // The company's own fields.
  const customFields = {};
  for (const key of new Set([...Object.keys(main.customFields || {}), ...Object.keys(other.customFields || {})])) {
    const value = pick(`cf.${key}`, (c) => c.customFields?.[key]);
    if (!blank(value)) customFields[key] = value;
  }
  values.customFields = customFields;
  const tags = [...(main.tags || [])];
  for (const tag of other.tags || []) if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  values.tags = tags;
  values.productIds = [...new Map([...(main.productIds || []), ...(other.productIds || [])].map((id) => [String(id), id])).values()];
  values.legacyIds = [...new Set([...(main.legacyIds || []), ...(other.legacyIds || [])])];
  const notes = [main.notes, other.notes].map((n) => String(n || '').trim()).filter(Boolean).filter((n, i, all) => all.indexOf(n) === i);
  for (const contact of [main, other]) {
    if (contact.phoneE164 && contact.phoneE164 !== values.phoneE164) notes.push(`Other mobile number (merged, ${contact.name}): ${contact.phoneE164}`);
    if (contact.email && contact.email !== values.email) notes.push(`Other email (merged, ${contact.name}): ${contact.email}`);
  }
  values.notes = notes.join('\n\n');
  const consent = [main, other].map((c) => c.consent?.marketing || 'unknown').sort((a, b) => CONSENT_RANK[b] - CONSENT_RANK[a])[0];
  values.consentMarketing = consent;
  values.smsOptOut = main.smsOptOut?.at ? main.smsOptOut : other.smsOptOut?.at ? other.smsOptOut : undefined;
  const customer = [main, other].some((c) => c.lifecycle === 'customer');
  values.lifecycle = customer ? 'customer' : main.lifecycle;
  values.becameCustomerAt = [main.becameCustomerAt, other.becameCustomerAt].filter(Boolean).sort((a, b) => a - b)[0];
  values.firstTouch = [main.firstTouch, other.firstTouch].filter((t) => t?.at).sort((a, b) => a.at - b.at)[0];
  values.lastContactedAt = [main.lastContactedAt, other.lastContactedAt].filter(Boolean).sort((a, b) => b - a)[0];
  return values;
}

// Two chats on one WhatsApp number become one: the other's messages, notes and history join the
// kept chat; the newest message, unread counts, labels and pins add up.
async function joinChat(chat, into, { O, session, keptOtherPhone }) {
  const moveTo = (Model, field) => Model.collection.updateMany({ ...O, [field]: chat._id }, { $set: { [field]: into._id } }, { session });
  for (const [Model, field] of [[Message, 'conversationId'], [ChatResolution, 'conversationId'], [BroadcastRecipient, 'conversationId'], [AiUsage, 'conversationId'], [Order, 'catalogOrder.conversationId'], [AutomationRun, 'subject.conversationId']]) {
    await moveTo(Model, field);
  }
  await Note.collection.updateMany({ ...O, parentType: 'conversation', parentId: chat._id }, { $set: { parentId: into._id } }, { session });
  const newer = (chat.lastMessageAt || 0) > (into.lastMessageAt || 0);
  const rank = { open: 2, pending: 1 };
  const set = {
    unreadCount: (into.unreadCount || 0) + (chat.unreadCount || 0),
    status: (rank[chat.status] || 0) > (rank[into.status] || 0) ? chat.status : into.status,
    tags: [...new Set([...(into.tags || []), ...(chat.tags || [])])],
    ...(newer && { lastMessageAt: chat.lastMessageAt, lastMessagePreview: chat.lastMessagePreview || '', lastMessageDirection: chat.lastMessageDirection || '', lastMessageOrigin: chat.lastMessageOrigin || '' }),
    // The 24-hour window is the number's: the kept chat's, or the other's when its number is kept.
    ...(keptOtherPhone && { lastInboundAt: chat.lastInboundAt || null }),
    ...(!into.assigneeId && chat.assigneeId && { assigneeId: chat.assigneeId }),
    ...((into.pinnedBy?.length || chat.pinnedBy?.length) && { pinnedBy: [...new Map([...(into.pinnedBy || []), ...(chat.pinnedBy || [])].map((id) => [String(id), id])).values()] }),
    ...(into.archivedAt && !chat.archivedAt && { archivedAt: null }),
    ...(chat.openedAt && (!into.openedAt || chat.openedAt < into.openedAt) && { openedAt: chat.openedAt }),
  };
  await Conversation.collection.updateOne({ _id: into._id }, { $set: set }, { session });
  await Conversation.collection.deleteOne({ _id: chat._id }, { session });
}

// POST /contacts/:id/merge { otherId, keep } — the other customer joins this one for good.
async function merge(req, mainId, { otherId, keep = {} }) {
  const organizationId = req.tenant.organizationId;
  let moved;
  let names;
  let stoppedSequences = [];
  await mongoose.connection.transaction(async (session) => {
    moved = {};
    const O = { organizationId };
    const { main, other } = await pairOf(req, mainId, otherId, session);
    names = { main: main.name, other: other.name, otherId: String(other._id) };
    const values = finalValues(main, other, keep);
    const keptOtherPhone = Boolean(other.phoneE164 && values.phoneE164 === other.phoneE164);
    const now = new Date();

    // The other customer goes first, so the number it frees can be the kept one's.
    await Contact.collection.updateOne({ _id: other._id }, { $set: { deletedAt: now, mergedIntoId: main._id }, $unset: { phoneE164: '' } }, { session });
    const consentBefore = main.consent?.marketing || 'unknown';
    const { consentMarketing, smsOptOut, ...fields } = values;
    main.set({ ...fields, ...(smsOptOut && { smsOptOut }) });
    if (!fields.phoneE164) main.phoneE164 = undefined;
    if (!fields.ownerId) main.ownerId = undefined;
    if (consentMarketing !== consentBefore) main.consent = { marketing: consentMarketing, changedAt: now, method: 'manual' };
    main.markModified('customFields');
    await main.save({ session });
    if (consentMarketing !== consentBefore) {
      await consentService.record({ organizationId, contactId: main._id, from: consentBefore, to: consentMarketing, method: 'manual', ...consentService.actorOf(req), detail: `Merged with ${other.name}`, session });
    }

    // Chats first: two on one WhatsApp number become one.
    const mainChats = await Conversation.find({ ...O, contactId: main._id }).session(session);
    const otherChats = await Conversation.find({ ...O, contactId: other._id }).session(session);
    moved.chats = 0;
    moved.chatsJoined = 0;
    for (const chat of otherChats) {
      const into = mainChats.find((c) => String(c.whatsappAccountId) === String(chat.whatsappAccountId));
      if (into) {
        await joinChat(chat, into, { O, session, keptOtherPhone });
        moved.chatsJoined += 1;
      } else {
        await Conversation.collection.updateOne({ _id: chat._id }, { $set: { contactId: main._id } }, { session });
        moved.chats += 1;
      }
    }

    // A sequence both are in: the other one's stops (one customer is in a sequence once).
    const both = await SequenceEnrollment.find({ ...O, contactId: main._id, status: 'active' }).distinct('sequenceId').session(session);
    stoppedSequences = await SequenceEnrollment.find({ ...O, contactId: other._id, status: 'active', sequenceId: { $in: both } }).distinct('sequenceId').session(session);
    await SequenceEnrollment.collection.updateMany(
      { ...O, contactId: other._id, status: 'active', sequenceId: { $in: both } },
      { $set: { status: 'stopped', stopReason: `Merged into ${values.name}, who is already in this sequence.`, finishedAt: now }, $unset: { nextAt: '' } },
      { session },
    );
    moved.sequences = (await SequenceEnrollment.collection.updateMany({ ...O, contactId: other._id }, { $set: { contactId: main._id } }, { session })).modifiedCount;
    // A broadcast both got stays in the other's history (one line per customer and broadcast).
    const got = await BroadcastRecipient.find({ ...O, contactId: main._id }).distinct('broadcastId').session(session);
    moved.broadcasts = (await BroadcastRecipient.collection.updateMany({ ...O, contactId: other._id, broadcastId: { $nin: got } }, { $set: { contactId: main._id } }, { session })).modifiedCount;

    for (const [name, Model] of MOVES) {
      moved[name] = (await Model.collection.updateMany({ ...O, contactId: other._id }, { $set: { contactId: main._id } }, { session })).modifiedCount;
    }
    moved.automationRuns = (await AutomationRun.collection.updateMany({ ...O, 'subject.contactId': other._id }, { $set: { 'subject.contactId': main._id } }, { session })).modifiedCount;
    for (const [name, Model] of RELATED) {
      moved[name] = (await Model.collection.updateMany({ ...O, ...relatedTo(other._id) }, { $set: { relatedId: main._id, relatedName: values.name } }, { session })).modifiedCount;
    }
    moved.notes = (await Note.collection.updateMany({ ...O, parentType: 'contact', parentId: other._id }, { $set: { parentId: main._id } }, { session })).modifiedCount;
    moved.emails = (await EmailMessage.collection.updateMany({ ...O, contactIds: other._id }, { $addToSet: { contactIds: main._id } }, { session })).modifiedCount;
    await EmailMessage.collection.updateMany({ ...O, contactIds: other._id }, { $pull: { contactIds: other._id } }, { session });
    await DialerSession.collection.updateMany(
      { ...O, 'items.contactId': other._id },
      { $set: { 'items.$[item].contactId': main._id } },
      { session, arrayFilters: [{ 'item.contactId': other._id }] },
    );
    // Link fields (D75) that pointed to the other customer now point to the kept one.
    const lookups = await CustomFieldDefinition.find({ ...O, type: 'lookup', lookupTarget: 'contact' }).session(session).lean();
    for (const field of lookups) {
      const Model = field.object === 'contact' ? Contact : field.object === 'lead' ? Lead : CustomRecord;
      await Model.collection.updateMany(
        { ...O, ...(Model === CustomRecord && { object: field.object }), [`customFields.${field.key}`]: String(other._id) },
        { $set: { [`customFields.${field.key}`]: String(main._id) } },
        { session },
      );
    }
  });

  const sequences = require('./automation/sequences'); // eslint-disable-line global-require
  await Promise.all(stoppedSequences.map((id) => sequences.refreshStats(id).catch(() => {})));
  await audit(req, { action: 'contact.merged', entityType: 'Contact', entityId: mainId, changes: { mergedId: names.otherId, mergedName: names.other, moved } });
  automationEvents.emit('contact.updated', { organizationId, contactId: mainId, key: `contact.updated:${mainId}:merge:${names.otherId}` }, req);
  return { contact: await contactService.get(req, mainId), moved };
}

module.exports = { duplicates, preview, merge, finalValues };
