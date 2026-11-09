const mongoose = require('mongoose');
const AssignmentHistory = require('../models/AssignmentHistory'); // eslint-disable-line no-unused-vars
const AuditLog = require('../models/AuditLog');
const AutomationRun = require('../models/AutomationRun');
const BroadcastRecipient = require('../models/BroadcastRecipient');
const CalendarEvent = require('../models/CalendarEvent');
const Call = require('../models/Call');
const ChatResolution = require('../models/ChatResolution');
const ConsentEvent = require('../models/ConsentEvent');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const DialerSession = require('../models/DialerSession');
const Document = require('../models/Document');
const EmailMessage = require('../models/EmailMessage');
const InboundEvent = require('../models/InboundEvent');
const Job = require('../models/Job');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const LeadIntake = require('../models/LeadIntake');
const Message = require('../models/Message');
const Note = require('../models/Note');
const Notification = require('../models/Notification');
const Order = require('../models/Order');
const Organization = require('../models/Organization');
const PaymentLink = require('../models/PaymentLink');
const PaymentReceipt = require('../models/PaymentReceipt');
const PrivacyRequest = require('../models/PrivacyRequest');
const PrivateNumber = require('../models/PrivateNumber');
const Quotation = require('../models/Quotation');
const ScheduledMessage = require('../models/ScheduledMessage');
const SequenceEnrollment = require('../models/SequenceEnrollment');
const SmsMessage = require('../models/SmsMessage');
const Task = require('../models/Task');
const TaxInvoice = require('../models/TaxInvoice');
const Ticket = require('../models/Ticket');
const Touchpoint = require('../models/Touchpoint');
const WebhookDelivery = require('../models/WebhookDelivery');
const WidgetClick = require('../models/WidgetClick');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { documentStorage } = require('../storage');
const { indiaDate } = require('../utils/dates');
const { OPEN_LINK_STATUSES } = require('../constants/payments');
const { OPEN_STAGES } = require('../constants/crm');
const automationEvents = require('./automation/events');
const customerData = require('./customerDataService');
const privacy = require('./privacyService');
const { textsFor } = require('./frontendTexts');

// Erasing a customer's data on their request (Phase 8, D120; India's DPDP Act 2023 s. 12). In one
// transaction, everything the CRM keeps about the customer is
// - deleted: chats and their messages, notes, files, SMS, emails, consent history, lead history,
//   open tasks and coming meetings, scheduled messages, website-button visits;
// - made anonymous, so the company's sales numbers stay right: leads, quotations, orders, payment
//   links, support tickets, done tasks and past meetings, calls (only the duration stays),
//   broadcast deliveries, ad touches, sequences and automation runs, enquiries (their source id
//   stays, so IndiaMART does not bring the same enquiry back);
// - kept as the law asks: tax invoices, credit notes and payment receipts, for 8 years after their
//   financial year (GST: 72 months after the annual return; the Companies Act: 8 years), then made
//   anonymous by the daily job below.
// The customer stays only as "an erased customer" (deleted, no name or details). Files, the
// 60-day webhook copies and the 30-day outgoing webhook copies go right after (a job). A customer
// merged into this one earlier (D100) is the same person and is erased too. It cannot be undone.
// docs/DATA_TRUST.md.

const JOBS = { CLEANUP: 'privacy.cleanup', RETENTION: 'privacy.retention' };
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_ORDER_STAGES = ['Received', 'Processing', 'Dispatched'];
const toId = (id) => new mongoose.Types.ObjectId(String(id));

// The last moment the law asks the company to keep a tax record of this day: 31 March, 8 years
// after its financial year (April–March, India time) ends.
function keptUntilOf(date) {
  const india = new Date(new Date(date).getTime() + 330 * 60 * 1000);
  const yearEnds = india.getUTCMonth() >= 3 ? india.getUTCFullYear() + 1 : india.getUTCFullYear();
  return new Date(Date.UTC(yearEnds + 8, 3, 1) - 330 * 60 * 1000 - 1);
}

const latest = (dates) => dates.filter(Boolean).reduce((max, d) => (!max || d > max ? d : max), null);

// What erasing would do, counted (the preview, and the summary kept in the register).
async function countsOf(organizationId, g, now = new Date()) {
  const today = indiaDate(0, now);
  const [messages, files] = await Promise.all([
    Message.collection.countDocuments(g.messagesFilter),
    Message.collection.countDocuments({ ...g.messagesFilter, 'media.storageKey': { $type: 'string' } }),
  ]);
  const openTasks = g.tasks.filter((t) => t.status !== 'Done' && !t.deletedAt).length;
  const comingMeetings = g.events.filter((e) => e.date >= today && !e.deletedAt).length;
  return {
    deleted: {
      chats: g.conversations.length,
      messages,
      notes: g.notes.length + g.leads.reduce((n, l) => n + (l.noteEntries?.length || 0) + (l.notes ? 1 : 0), 0) + (g.contact.notes ? 1 : 0),
      files: g.documents.filter((d) => d.storageKey || d.linkUrl).length + files,
      sms: g.sms.length,
      emails: g.emails.length,
      calls: 0,
      consentEvents: g.consentEvents.length,
      leadHistory: g.activities.length,
      openTasks,
      comingMeetings,
      scheduledMessages: g.scheduled.length,
    },
    anonymised: {
      leads: g.leads.length,
      quotations: g.quotations.length,
      orders: g.orders.length,
      paymentLinks: g.paymentLinks.length,
      tickets: g.tickets.length,
      doneTasks: g.tasks.length - openTasks,
      pastMeetings: g.events.length - comingMeetings,
      calls: g.calls.length,
      broadcasts: g.broadcasts.length,
      adTouches: g.touchpoints.length,
      sequences: g.enrollments.length,
      enquiries: g.intakes.length,
    },
    kept: { invoices: g.invoices.length, receipts: g.receipts.length },
  };
}

function warningsOf(g) {
  const live = (o) => !o.deletedAt && o.stage !== 'Cancelled';
  const due = g.orders.filter(live).reduce((sum, o) => sum + Math.max(0, (o.billedPaise ?? o.totals?.grandTotalPaise ?? 0) - (o.amountPaidPaise || 0)), 0);
  return {
    openOrders: g.orders.filter((o) => live(o) && OPEN_ORDER_STAGES.includes(o.stage)).length,
    duePaise: due,
    openLeads: g.leads.filter((l) => !l.deletedAt && OPEN_STAGES.includes(l.stage)).length,
    openPaymentLinks: g.paymentLinks.filter((l) => OPEN_LINK_STATUSES.includes(l.status)).length,
  };
}

const keptUntilFor = (g) => latest([
  ...g.invoices.map((i) => keptUntilOf(i.invoiceDate || i.createdAt)),
  ...g.receipts.map((r) => keptUntilOf(r.receiptDate || r.createdAt)),
]);

// GET /contacts/:id/privacy/erase-preview
async function preview(req, id) {
  await privacy.assertMayHandle(req);
  const contact = await customerData.findContact(req, id);
  const g = await customerData.gather(req.tenant.organizationId, contact);
  return {
    customer: { id: String(contact._id), name: contact.name || '', deleted: Boolean(contact.deletedAt) },
    counts: await countsOf(req.tenant.organizationId, g),
    keptUntil: keptUntilFor(g),
    warnings: warningsOf(g),
    linked: { projects: g.projects.map((p) => p.name), records: g.records.map((r) => r.name) },
  };
}

// --- the erasure ------------------------------------------------------------------------------

// The customer as "an erased customer": deleted, without anything that says who they were.
const tombstone = (label, now, erasure) => ({
  $set: {
    name: label, email: '', phone: '', company: '', gstin: '', stateCode: '', state: '', city: '', address: '',
    tags: [], notes: '', productIds: [], deletedAt: now, erasure,
  },
  $unset: {
    phoneE164: '', customFields: '', legacyIds: '', firstTouch: '', blocked: '', smsOptOut: '', consent: '', sourceRef: '',
    private: '', lastContactedAt: '',
  },
});

// Erases one customer (and those merged into them). by: { memberId } or nothing (a backup restore
// putting an erasure back). → { at, counts, keptUntil, files, cleanup }.
async function eraseContact({ organizationId, contact, label, by = {}, now = new Date() }) {
  const O = { organizationId: toId(organizationId) };
  const g = await customerData.gather(organizationId, contact);
  const counts = await countsOf(organizationId, g, now);
  const keptUntil = keptUntilFor(g);
  const id = contact._id;
  const today = indiaDate(0, now);
  const merged = await Contact.collection.find({ ...O, mergedIntoId: id }).project({ _id: 1, phoneE164: 1, phone: 1, email: 1 }).toArray();
  const contactIds = [id, ...merged.map((m) => m._id)];
  // Files: removed once the records are gone (only those nothing else still uses).
  const fileKeys = [
    ...g.documents.map((d) => d.storageKey).filter(Boolean),
    ...(await Message.collection.distinct('media.storageKey', { ...g.messagesFilter, 'media.storageKey': { $type: 'string' } })),
  ];
  const phones = [contact.phoneE164, ...merged.map((m) => m.phoneE164)].filter(Boolean);
  const ids = [...contactIds, ...g.leadIds, ...g.conversationIds, ...g.ticketIds, ...g.quotationIds, ...g.orderIds].map(String);
  const eventsToSync = g.events.filter((e) => e.external?.google?.id || e.external?.microsoft?.id || e.external?.google?.state || e.external?.microsoft?.state);
  const relatedFilter = { $or: [{ relatedType: { $in: ['Customer', 'Contact'] }, relatedId: { $in: contactIds } }, { relatedType: { $in: ['Lead', 'Deal'] }, relatedId: { $in: g.leadIds } }] };
  const chats = { $in: g.conversationIds };
  const leads = { $in: g.leadIds };
  const anyOf = (field, list) => ({ [field]: { $in: list } });
  const erasure = { at: now, byMemberId: by.memberId, ...(keptUntil && { keptUntil }) };

  await mongoose.connection.transaction(async (session) => {
    const s = { session };
    // Deleted
    await Message.collection.deleteMany(g.messagesFilter, s);
    await Conversation.collection.deleteMany({ ...O, _id: chats }, s);
    await ChatResolution.collection.deleteMany({ ...O, conversationId: chats }, s);
    await ScheduledMessage.collection.deleteMany({ ...O, $or: [anyOf('contactId', contactIds), { conversationId: chats }] }, s);
    await Note.collection.deleteMany({ ...O, $or: [{ parentType: 'contact', parentId: { $in: contactIds } }, { parentType: 'conversation', parentId: chats }, { parentType: 'ticket', parentId: { $in: g.ticketIds } }] }, s);
    await Document.collection.deleteMany({ ...O, ...relatedFilter }, s);
    await SmsMessage.collection.deleteMany({ ...O, ...anyOf('contactId', contactIds) }, s);
    await EmailMessage.collection.deleteMany({ ...O, ...anyOf('contactIds', contactIds) }, s);
    await ConsentEvent.collection.deleteMany({ ...O, ...anyOf('contactId', contactIds) }, s);
    await LeadActivity.collection.deleteMany({ ...O, $or: [anyOf('contactId', contactIds), { leadId: leads }] }, s);
    await WidgetClick.collection.deleteMany({ ...O, ...anyOf('contactId', contactIds) }, s);
    if (phones.length) await PrivateNumber.collection.deleteMany({ ...O, phoneE164: { $in: phones } }, s);
    await Notification.collection.deleteMany({ ...O, link: { $regex: ids.join('|') } }, s);
    await DialerSession.collection.updateMany({ ...O, 'items.contactId': { $in: contactIds } }, { $pull: { items: { contactId: { $in: contactIds } } } }, s);

    // Tasks and meetings: the open and coming ones go (deleted, so a calendar copy is removed too);
    // the rest stay without the customer in them.
    const work = { $set: { title: label, description: '', relatedName: '' } };
    await Task.collection.updateMany({ ...O, ...relatedFilter, status: { $ne: 'Done' } }, { ...work, $set: { ...work.$set, deletedAt: now } }, s);
    await Task.collection.updateMany({ ...O, ...relatedFilter, status: 'Done' }, work, s);
    await CalendarEvent.collection.updateMany({ ...O, ...relatedFilter, date: { $gte: today } }, { $set: { ...work.$set, deletedAt: now } }, s);
    await CalendarEvent.collection.updateMany({ ...O, ...relatedFilter, date: { $lt: today } }, work, s);
    await CalendarEvent.collection.updateMany({ ...O, ...relatedFilter, 'online.joinUrl': { $type: 'string', $ne: '' } }, { $set: { 'online.joinUrl': '' } }, s);

    // Made anonymous
    const party = { name: label };
    await Lead.collection.updateMany({ ...O, _id: leads }, { $set: { title: label, notes: '', noteEntries: [], lostReason: '', customFields: {} }, $unset: { legacyIds: '', sourceRef: '' } }, s);
    await LeadIntake.collection.updateMany({ ...O, $or: [anyOf('contactId', contactIds), { leadId: leads }] }, { $set: { summary: '', reason: '' }, $unset: { raw: '' } }, s);
    // ($[] only where the list is there: older records may not have it.)
    const quotations = { ...O, _id: { $in: g.quotationIds } };
    await Quotation.collection.updateMany(quotations, { $set: { billTo: party, notes: '' } }, s);
    await Quotation.collection.updateMany({ ...quotations, 'revisions.0': { $exists: true } }, { $set: { 'revisions.$[].billTo': party, 'revisions.$[].notes': '' } }, s);
    const orders = { ...O, _id: { $in: g.orderIds } };
    await Order.collection.updateMany(orders, { $set: { billTo: party, notes: '', cancelReason: '' } }, s);
    await Order.collection.updateMany({ ...orders, 'catalogOrder.text': { $type: 'string' } }, { $set: { 'catalogOrder.text': '' } }, s);
    await Order.collection.updateMany({ ...orders, 'history.0': { $exists: true } }, { $set: { 'history.$[].note': '' } }, s);
    await PaymentLink.collection.updateMany({ ...O, _id: { $in: g.paymentLinks.map((l) => l._id) } }, { $set: { customerName: label, description: '' } }, s);
    await Ticket.collection.updateMany({ ...O, _id: { $in: g.ticketIds } }, { $set: { subject: label, description: '', customerName: '' } }, s);
    await Call.collection.updateMany({ ...O, ...anyOf('contactId', contactIds) }, { $set: { notes: '', fromNumber: '', toNumber: '' }, $unset: { 'whatsapp.offer': '', 'whatsapp.answer': '' } }, s);
    await BroadcastRecipient.collection.updateMany({ ...O, ...anyOf('contactId', contactIds) }, { $set: { name: '', phoneE164: '', reason: '' } }, s);
    await Touchpoint.collection.updateMany({ ...O, ...anyOf('contactId', contactIds) }, { $unset: { clickIds: '', referrer: '', landingPage: '' } }, s);
    await SequenceEnrollment.collection.updateMany({ ...O, ...anyOf('contactId', contactIds), status: 'active' }, { $set: { status: 'stopped', stopReason: 'The customer\'s data was erased.', finishedAt: now }, $unset: { nextAt: '' } }, s);
    const runs = { ...O, $or: [{ 'subject.contactId': { $in: contactIds } }, { 'subject.leadId': leads }, { 'subject.conversationId': chats }] };
    await AutomationRun.collection.updateMany({ ...runs, status: { $in: ['running', 'waiting'] } }, { $set: { status: 'cancelled', error: 'The customer\'s data was erased.', finishedAt: now }, $unset: { nextAt: '' } }, s);
    await AutomationRun.collection.updateMany(runs, { $set: { 'subject.label': label, event: {} } }, s);
    await AutomationRun.collection.updateMany({ ...runs, 'steps.0': { $exists: true } }, { $set: { 'steps.$[].detail': '' } }, s);
    // The audit log keeps what was done, not who it was about.
    await AuditLog.collection.updateMany({ ...O, entityType: 'Contact', entityId: { $in: contactIds.map(String) } }, { $unset: { 'changes.mergedName': '', 'changes.reason': '', 'changes.whatsappNote': '' } }, s);
    await PrivacyRequest.collection.updateMany({ ...O, contactId: { $in: contactIds } }, { $set: { contactName: '' } }, s);

    // The customer, and anyone merged into them.
    await Contact.collection.updateOne({ ...O, _id: id }, tombstone(label, contact.deletedAt || now, erasure), s);
    if (merged.length) await Contact.collection.updateMany({ ...O, _id: { $in: merged.map((m) => m._id) } }, tombstone(label, now, { at: now, byMemberId: by.memberId }), s);
  });

  // After the commit: calendars told, and the slower clean-up queued.
  for (const event of eventsToSync) {
    const doc = { ...event, deletedAt: event.date >= today ? now : event.deletedAt };
    require('./googleCalendarService').queueSync(doc).catch(() => {}); // eslint-disable-line global-require
    require('./outlookService').queueSync(doc).catch(() => {}); // eslint-disable-line global-require
  }
  const sequences = [...new Set(g.enrollments.map((e) => String(e.sequenceId)))];
  return {
    at: now,
    counts,
    keptUntil,
    contactIds,
    cleanup: {
      organizationId: String(organizationId),
      fileKeys: [...new Set(fileKeys)],
      waIds: [...new Set(phones.map((p) => p.replace(/\D/g, '')))],
      contactIds: contactIds.map(String),
      leadIds: g.leadIds.map(String),
      conversationIds: g.conversationIds.map(String),
      openLinkIds: g.paymentLinks.filter((l) => OPEN_LINK_STATUSES.includes(l.status) && !l.amountPaidPaise).map((l) => String(l._id)),
      sequenceIds: sequences,
    },
  };
}

// POST /contacts/:id/privacy/erase { confirmName, askedAt, language }
async function erase(req, id, { confirmName, askedAt, language = 'en' } = {}, queue = require('../jobs/queue')) {
  await privacy.assertMayHandle(req);
  const contact = await customerData.findContact(req, id);
  const typed = String(confirmName || '').trim().toLowerCase();
  if (!typed || typed !== String(contact.name || '').trim().toLowerCase()) {
    throw httpError(400, 'VALIDATION_ERROR', 'Type the customer\'s name exactly as it is shown, to confirm.', [{ field: 'confirmName', message: 'Type the customer\'s name exactly.' }]);
  }
  const asked = privacy.askedAtOf(askedAt);
  const label = textsFor(language)('pdata.erasedCustomer');
  const result = await eraseContact({ organizationId: req.tenant.organizationId, contact, label, by: { memberId: req.member?._id } });

  await queue.enqueue(JOBS.CLEANUP, result.cleanup, { organizationId: req.tenant.organizationId, maxAttempts: 5 });
  // The team's phones drop their copies of the Inbox (Phase 7) on their next page.
  await Organization.updateOne({ _id: req.tenant.organizationId }, { $set: { 'settings.privacy.lastErasureAt': result.at } });
  await privacy.record(req, { type: 'erasure', contactId: contact._id, contactName: '', askedAt: asked, summary: result.counts, ...(result.keptUntil && { keptUntil: result.keptUntil }) });
  await audit(req, { action: 'contact.erased', entityType: 'Contact', entityId: contact._id, changes: { ...result.counts, keptUntil: result.keptUntil } });
  // Connected systems (webhooks) are told, so they can erase their copies too.
  automationEvents.emit('contact.erased', { organizationId: req.tenant.organizationId, contactId: contact._id, erasedAt: result.at.toISOString(), key: `contact.erased:${contact._id}` }, req);
  // A note for a restore from an older backup (services/backupService.js).
  await require('./backupService').markErased({ organizationId: req.tenant.organizationId, contactIds: result.contactIds, at: result.at }).catch((error) => logger.error(`The erasure note for backups could not be written: ${error.message}`)); // eslint-disable-line global-require
  return { erasedAt: result.at, counts: result.counts, keptUntil: result.keptUntil };
}

// --- after the erasure --------------------------------------------------------------------------

// The job: stored files nothing else uses, the webhook copies that held the customer's messages or
// details, open payment links cancelled at the gateway, sequences' numbers. Its own data (it holds
// the WhatsApp number) is cleared when it is done.
async function cleanup(data, job) {
  const O = { organizationId: toId(data.organizationId) };
  const keys = data.fileKeys || [];
  if (keys.length) {
    const [inMessages, inDocuments] = await Promise.all([
      Message.collection.distinct('media.storageKey', { ...O, 'media.storageKey': { $in: keys } }),
      Document.collection.distinct('storageKey', { ...O, storageKey: { $in: keys } }),
    ]);
    const used = new Set([...inMessages, ...inDocuments]);
    for (const key of keys.filter((k) => !used.has(k))) {
      try {
        await documentStorage.remove(key);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  if (data.waIds?.length) {
    const wa = data.waIds;
    await InboundEvent.collection.deleteMany({
      provider: 'whatsapp',
      $or: [{ 'payload.message.from': { $in: wa } }, { 'payload.message.to': { $in: wa } }, { 'payload.contact.wa_id': { $in: wa } }, { 'payload.status.recipient_id': { $in: wa } }, { 'payload.call.from': { $in: wa } }, { 'payload.call.to': { $in: wa } }],
    });
  }
  const ids = [...(data.contactIds || []), ...(data.leadIds || [])];
  if (ids.length || data.conversationIds?.length) {
    await WebhookDelivery.collection.deleteMany({
      ...O,
      event: { $ne: 'contact.erased' },
      $or: [
        { 'payload.data.contact.id': { $in: data.contactIds || [] } },
        { 'payload.data.lead.id': { $in: data.leadIds || [] } },
        { 'payload.data.lead.contactId': { $in: data.contactIds || [] } },
        { 'payload.data.quotation.contactId': { $in: data.contactIds || [] } },
        { 'payload.data.order.contactId': { $in: data.contactIds || [] } },
        { 'payload.data.record.contactId': { $in: data.contactIds || [] } },
        { 'payload.data.conversationId': { $in: data.conversationIds || [] } },
      ],
    });
  }
  for (const linkId of data.openLinkIds || []) {
    try {
      const link = await PaymentLink.findOne({ _id: linkId, ...O });
      if (link && OPEN_LINK_STATUSES.includes(link.status) && !link.amountPaidPaise) {
        const system = { tenant: { organizationId: link.organizationId }, member: { _id: undefined, role: 'owner', modules: [], permissions: [], status: 'active' }, user: { _id: undefined, name: 'AgreemCRM' }, id: `erasure:${linkId}`, ip: '', get: () => '' };
        await require('./paymentLinkService').cancel(system, link._id); // eslint-disable-line global-require
      }
    } catch (error) {
      logger.warn(`An erased customer's payment link ${linkId} could not be cancelled: ${error.message}`);
    }
  }
  const sequences = require('./automation/sequences'); // eslint-disable-line global-require
  await Promise.all((data.sequenceIds || []).map((id) => sequences.refreshStats(id).catch(() => {})));
  if (job?._id) await Job.updateOne({ _id: job._id }, { $set: { data: {} } });
}

// The daily job: tax records whose years are over are made anonymous too, and the erasure is done.
async function finishDue(now = new Date()) {
  const due = await Contact.collection.find({ 'erasure.keptUntil': { $lt: now }, 'erasure.finishedAt': null }).project({ organizationId: 1, name: 1 }).limit(200).toArray();
  for (const contact of due) {
    const O = { organizationId: contact.organizationId };
    const party = { name: contact.name };
    const orderIds = await Order.collection.distinct('_id', { ...O, contactId: contact._id });
    const theirs = { ...O, $or: [{ contactId: contact._id }, { orderId: { $in: orderIds } }] };
    await TaxInvoice.collection.updateMany(theirs, { $set: { billTo: party } });
    await PaymentReceipt.collection.updateMany(theirs, { $set: { receivedFrom: party } });
    await Contact.collection.updateOne({ _id: contact._id }, { $set: { 'erasure.finishedAt': now } });
  }
  if (due.length) logger.info(`Erasures finished after the tax years: ${due.length}`);
  return due.length;
}

function register(queue) {
  queue.define(JOBS.CLEANUP, (data, job) => cleanup(data, job), { maxAttempts: 5 });
  queue.define(JOBS.RETENTION, () => finishDue(), { maxAttempts: 2 });
  queue.every(JOBS.RETENTION, DAY_MS).catch((error) => logger.error(`Scheduling ${JOBS.RETENTION} failed: ${error.message}`));
}

module.exports = { JOBS, preview, erase, eraseContact, cleanup, finishDue, register, keptUntilOf, countsOf };
