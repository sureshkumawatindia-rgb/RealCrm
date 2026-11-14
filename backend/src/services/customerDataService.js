const mongoose = require('mongoose');
const AiUsage = require('../models/AiUsage');
const Broadcast = require('../models/Broadcast');
const BroadcastRecipient = require('../models/BroadcastRecipient');
const CalendarEvent = require('../models/CalendarEvent');
const Call = require('../models/Call');
const ConsentEvent = require('../models/ConsentEvent');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const ConversionsApiConnection = require('../models/ConversionsApiConnection');
const CsatSurvey = require('../models/CsatSurvey');
const CustomObjectDefinition = require('../models/CustomObjectDefinition');
const CustomRecord = require('../models/CustomRecord');
const Document = require('../models/Document');
const EmailMessage = require('../models/EmailMessage');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const LeadIntake = require('../models/LeadIntake');
const Message = require('../models/Message');
const Note = require('../models/Note');
const Order = require('../models/Order');
const Organization = require('../models/Organization');
const PaymentLink = require('../models/PaymentLink');
const PaymentReceipt = require('../models/PaymentReceipt');
const Pipeline = require('../models/Pipeline');
const Product = require('../models/Product');
const Project = require('../models/Project');
const Quotation = require('../models/Quotation');
const ScheduledMessage = require('../models/ScheduledMessage');
const SequenceEnrollment = require('../models/SequenceEnrollment');
const SheetSync = require('../models/SheetSync');
const SmsMessage = require('../models/SmsMessage');
const Task = require('../models/Task');
const TaxInvoice = require('../models/TaxInvoice');
const Ticket = require('../models/Ticket');
const Touchpoint = require('../models/Touchpoint');
const WebhookSubscription = require('../models/WebhookSubscription');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { PAYMENT_PROVIDERS } = require('../constants/payments');
const customFieldService = require('./customFieldService');
const privacy = require('./privacyService');
const { textsFor } = require('./frontendTexts');
const page = require('../views/customerDataPage');

// A customer's own data (Phase 8, D120; India's DPDP Act 2023 s. 11): everything the company keeps
// about one customer, found through the customer, their leads and their chats — deleted records
// too (they are still kept) — as a file to give them: a page anyone can read and print, in the
// person's language, or JSON for another system. It also says who else handled the data (s. 11(1)(b)).
// The same gathering tells the erasure (services/erasureService.js) what to remove.

const toId = (id) => new mongoose.Types.ObjectId(String(id));
const dayText = (date) => new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

// The customer a request is about: deleted ones too (their data is still kept), never one whose
// data was already erased; a private number (D61) only for owners. → the stored document.
async function findContact(req, id) {
  if (!mongoose.isValidObjectId(id)) throw httpError(404, 'NOT_FOUND', 'Contact not found');
  const contact = await Contact.collection.findOne({ _id: toId(id), organizationId: toId(req.tenant.organizationId) });
  if (!contact || (contact.private && req.member?.role !== 'owner')) throw httpError(404, 'NOT_FOUND', 'Contact not found');
  if (contact.erasure?.at) throw erasedError(contact);
  return contact;
}

function erasedError(contact) {
  return httpError(410, 'ERASED', `This customer's data was erased on ${dayText(contact.erasure.at)}.`, [{ field: 'erasedAt', code: 'ERASED', message: new Date(contact.erasure.at).toISOString() }]);
}

// Everything that belongs to the customer, as stored (soft-deleted records too).
async function gather(organizationId, contact) {
  const O = { organizationId: toId(organizationId) };
  const id = contact._id;
  const all = (Model, filter, sort = { _id: 1 }) => Model.collection.find({ ...O, ...filter }).sort(sort).toArray();
  const leads = await all(Lead, { contactId: id }, { createdAt: 1 });
  const leadIds = leads.map((lead) => lead._id);
  const [conversations, tickets, quotations, orders] = await Promise.all([
    all(Conversation, { contactId: id }, { createdAt: 1 }),
    all(Ticket, { contactId: id }, { createdAt: 1 }),
    all(Quotation, { $or: [{ contactId: id }, { leadId: { $in: leadIds } }] }, { quotationDate: 1 }),
    all(Order, { $or: [{ contactId: id }, { leadId: { $in: leadIds } }] }, { orderDate: 1 }),
  ]);
  const conversationIds = conversations.map((c) => c._id);
  const ticketIds = tickets.map((t) => t._id);
  const quotationIds = quotations.map((q) => q._id);
  const orderIds = orders.map((o) => o._id);
  // Tasks, meetings and files about the customer or one of their leads ("deals").
  const related = { $or: [{ relatedType: { $in: ['Customer', 'Contact'] }, relatedId: id }, { relatedType: { $in: ['Lead', 'Deal'] }, relatedId: { $in: leadIds } }] };
  const chatOrContact = { $or: [{ contactId: id }, { conversationId: { $in: conversationIds } }] };
  const [
    invoices, receipts, paymentLinks, tasks, events, documents, notes, calls, sms, emails, consentEvents, touchpoints,
    intakes, activities, broadcasts, enrollments, scheduled, csat, projects, records,
  ] = await Promise.all([
    all(TaxInvoice, { $or: [{ contactId: id }, { orderId: { $in: orderIds } }] }, { invoiceDate: 1 }),
    all(PaymentReceipt, { $or: [{ contactId: id }, { orderId: { $in: orderIds } }] }, { receiptDate: 1 }),
    all(PaymentLink, { $or: [{ contactId: id }, { orderId: { $in: orderIds } }, { quotationId: { $in: quotationIds } }] }, { createdAt: 1 }),
    all(Task, related, { createdAt: 1 }),
    all(CalendarEvent, related, { date: 1 }),
    all(Document, related, { createdAt: 1 }),
    all(Note, { $or: [{ parentType: 'contact', parentId: id }, { parentType: 'conversation', parentId: { $in: conversationIds } }, { parentType: 'ticket', parentId: { $in: ticketIds } }] }, { createdAt: 1 }),
    all(Call, { contactId: id }, { startedAt: 1 }),
    all(SmsMessage, { contactId: id }, { createdAt: 1 }),
    all(EmailMessage, { contactIds: id }, { sentAt: 1 }),
    all(ConsentEvent, { contactId: id }, { at: 1 }),
    all(Touchpoint, { contactId: id }, { at: 1 }),
    all(LeadIntake, { $or: [{ contactId: id }, { leadId: { $in: leadIds } }] }, { receivedAt: 1 }),
    all(LeadActivity, { $or: [{ contactId: id }, { leadId: { $in: leadIds } }] }, { createdAt: 1 }),
    all(BroadcastRecipient, { contactId: id }, { createdAt: 1 }),
    all(SequenceEnrollment, { contactId: id }, { createdAt: 1 }),
    all(ScheduledMessage, chatOrContact, { sendAt: 1 }),
    all(CsatSurvey, chatOrContact, { askedAt: 1 }),
    all(Project, { contactId: id }, { createdAt: 1 }),
    all(CustomRecord, { contactId: id }, { createdAt: 1 }),
  ]);
  return {
    contact, leads, leadIds, conversations, conversationIds, tickets, ticketIds, quotations, quotationIds, orders, orderIds,
    invoices, receipts, paymentLinks, tasks, events, documents, notes, calls, sms, emails, consentEvents, touchpoints,
    intakes, activities, broadcasts, enrollments, scheduled, csat, projects, records,
    messagesFilter: { ...O, $or: [{ contactId: id }, { conversationId: { $in: conversationIds } }] },
  };
}

// --- the file -------------------------------------------------------------------------------

const iso = (date) => (date ? new Date(date).toISOString() : null);
const party = (p = {}) => Object.fromEntries(['name', 'company', 'phone', 'email', 'gstin', 'address', 'city', 'state', 'postalCode'].map((k) => [k, p[k] || '']).filter(([, v]) => v));
const items = (list = []) => list.map((item) => ({ name: item.name || '', quantity: item.quantity, unit: item.unit || '', totalPaise: item.totalPaise || 0 }));
const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

// A chat message as one line: its words, or what was sent (a photo, a file and its name …).
function messageOf(message) {
  const media = message.media || {};
  return {
    at: iso(message.providerTimestamp || message.createdAt),
    from: message.direction === 'in' ? 'customer' : 'company',
    type: message.type,
    text: message.text || message.order?.text || '',
    ...(media.fileName && { file: media.fileName }),
    ...(media.voice && { voice: true }),
    ...(message.type === 'location' && { location: [message.location?.name, message.location?.address].filter(Boolean).join(', ') }),
    ...(message.type === 'reaction' && message.reaction?.emoji && { reaction: message.reaction.emoji }),
    ...(message.form?.answers?.length && { answers: message.form.answers.map((a) => ({ label: a.label, value: a.value })) }),
    ...(message.template?.name && { template: message.template.name }),
  };
}

// The company's own fields as label → words, only those still in use.
async function fieldTexts(req, object, docs) {
  const fields = (await customFieldService.fieldsFor(req, object)).filter((field) => field.status === 'active');
  if (!fields.length) return () => [];
  return (doc) => fields
    .map((field) => ({ label: field.label, value: customFieldService.displayText(field, doc.customFields?.[field.key]) }))
    .filter((entry) => entry.value);
}

// Who else handled the customer's data (s. 11(1)(b)): the services the company used for it.
async function sharedWith(organizationId, g, t, company) {
  const O = { organizationId: toId(organizationId) };
  const list = [{ name: 'agreem360', purpose: t('pdata.sh.crm', { company }) }];
  const channels = new Set(g.conversations.map((c) => c.channel || 'whatsapp'));
  if (channels.has('whatsapp')) list.push({ name: 'WhatsApp (Meta)', purpose: t('pdata.sh.whatsapp') });
  if (channels.has('instagram')) list.push({ name: 'Instagram (Meta)', purpose: t('pdata.sh.instagram') });
  if (channels.has('messenger')) list.push({ name: 'Messenger (Meta)', purpose: t('pdata.sh.messenger') });
  for (const provider of new Set(g.paymentLinks.map((l) => l.provider).filter((p) => p && p !== 'mock'))) {
    list.push({ name: PAYMENT_PROVIDERS[provider] || provider, purpose: t('pdata.sh.payments') });
  }
  if (g.sms.some((s) => s.provider === 'msg91')) list.push({ name: 'MSG91', purpose: t('pdata.sh.sms') });
  if (g.calls.some((c) => c.provider === 'exotel')) list.push({ name: 'Exotel', purpose: t('pdata.sh.calls') });
  if (g.emails.length) list.push({ name: 'Gmail / Outlook', purpose: t('pdata.sh.email', { company }) });
  const [ai, capi, sheets, hooks] = await Promise.all([
    g.conversationIds.length ? AiUsage.collection.countDocuments({ ...O, conversationId: { $in: g.conversationIds } }, { limit: 1 }) : 0,
    g.touchpoints.some((tp) => tp.clickIds?.ctwaClid) ? ConversionsApiConnection.collection.countDocuments({ ...O, status: 'connected' }, { limit: 1 }) : 0,
    SheetSync.collection.find({ ...O, status: 'active' }).project({ kind: 1 }).toArray(),
    WebhookSubscription.collection.find({ ...O, active: true }).project({ url: 1 }).toArray(),
  ]);
  if (ai) list.push({ name: 'Anthropic (Claude)', purpose: t('pdata.sh.ai') });
  if (capi) list.push({ name: 'Meta (Conversions API)', purpose: t('pdata.sh.capi') });
  if (sheets.some((s) => (s.kind === 'leads' && g.leads.length) || (s.kind === 'orders' && g.orders.length))) list.push({ name: 'Google Sheets', purpose: t('pdata.sh.sheets', { company }) });
  if (g.events.some((e) => e.external?.google?.id || e.external?.microsoft?.id)) list.push({ name: 'Google Calendar / Outlook', purpose: t('pdata.sh.calendar', { company }) });
  if (g.documents.some((d) => d.external?.google?.fileId)) list.push({ name: 'Google Drive', purpose: t('pdata.sh.drive', { company }) });
  const hosts = [...new Set(hooks.map((h) => hostOf(h.url)).filter(Boolean))];
  if (hosts.length) list.push({ name: hosts.join(', '), purpose: t('pdata.sh.webhooks', { company }) });
  return list;
}

// The customer's data as a plain object (the JSON file; the page is drawn from it).
async function build(req, g, { askedAt, t }) {
  const organizationId = req.tenant.organizationId;
  const O = { organizationId: toId(organizationId) };
  const c = g.contact;
  const organization = await Organization.findById(organizationId).select('name email phone settings.privacy').lean();
  const company = organization?.name || '';
  const productIds = [...new Set(g.leads.map((l) => String(l.productId || '')).filter(Boolean))].map(toId);
  const [products, pipelines, broadcastNames, objectNames, contactFields, leadFields, messages] = await Promise.all([
    productIds.length ? Product.collection.find({ ...O, _id: { $in: productIds } }).project({ name: 1 }).toArray() : [],
    Pipeline.collection.find(O).project({ stages: 1 }).toArray(),
    g.broadcasts.length ? Broadcast.collection.find({ ...O, _id: { $in: g.broadcasts.map((b) => b.broadcastId) } }).project({ name: 1 }).toArray() : [],
    g.records.length ? CustomObjectDefinition.collection.find(O).project({ key: 1, singular: 1 }).toArray() : [],
    fieldTexts(req, 'contact'),
    fieldTexts(req, 'lead'),
    Message.collection.find(g.messagesFilter).sort({ conversationId: 1, createdAt: 1, _id: 1 }).toArray(),
  ]);
  const productName = new Map(products.map((p) => [String(p._id), p.name]));
  const stageName = new Map(pipelines.flatMap((p) => (p.stages || []).map((s) => [String(s._id), s.name])));
  const broadcastName = new Map(broadcastNames.map((b) => [String(b._id), b.name]));
  const objectName = new Map(objectNames.map((o) => [o.key, o.singular || o.key]));
  const deleted = (doc) => (doc.deletedAt ? { deleted: true } : {});
  const byChat = new Map();
  for (const message of messages) {
    const key = String(message.conversationId);
    if (!byChat.has(key)) byChat.set(key, []);
    byChat.get(key).push(messageOf(message));
  }
  const notes = [
    ...g.notes.map((n) => ({ at: iso(n.createdAt), text: n.text })),
    ...g.leads.flatMap((l) => [
      ...(l.notes ? [{ at: iso(l.createdAt), text: l.notes }] : []),
      ...(l.noteEntries || []).map((e) => ({ at: iso(e.createdAt), text: [e.title, e.text].filter(Boolean).join(': ') })),
    ]),
    ...(c.notes ? [{ at: iso(c.createdAt), text: c.notes }] : []),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const contactPerson = privacy.publicContactOf(organization);

  return {
    format: 'yellow-crm-customer-data',
    version: 1,
    madeAt: iso(new Date()),
    askedAt: iso(askedAt),
    language: t.language,
    company: { name: company, privacyContact: { name: contactPerson.name, email: contactPerson.email, phone: contactPerson.phone }, privacyNotice: contactPerson.noticeUrl },
    customer: {
      id: String(c._id),
      name: c.name || '',
      phone: c.phoneE164 || c.phone || '',
      email: c.email || '',
      company: c.company || '',
      gstin: c.gstin || '',
      address: c.address || '',
      city: c.city || '',
      state: c.state || '',
      tags: c.tags || [],
      status: c.status || '',
      lifecycle: c.lifecycle || '',
      source: c.source || '',
      addedAt: iso(c.createdAt),
      customerSince: iso(c.becameCustomerAt),
      customFields: contactFields(c),
      marketingConsent: c.consent?.marketing || 'unknown',
      smsOptOut: c.smsOptOut?.at ? iso(c.smsOptOut.at) : null,
      blocked: Boolean(c.blocked?.at),
      ...deleted(c),
    },
    consentHistory: g.consentEvents.map((e) => ({ at: iso(e.at), channel: e.channel || 'whatsapp', from: e.from, to: e.to, method: e.method })),
    howYouReachedUs: {
      firstTouch: c.firstTouch?.channel ? { at: iso(c.firstTouch.at), channel: c.firstTouch.channel, source: c.firstTouch.source || '', campaign: c.firstTouch.campaign || '' } : null,
      touchpoints: g.touchpoints.map((tp) => ({ at: iso(tp.at), channel: tp.channel, source: tp.source, campaign: tp.utm?.campaign || tp.ad?.name || tp.ad?.formName || '', page: tp.landingPage || '' })),
      enquiries: g.intakes.map((i) => ({ at: iso(i.receivedAt), source: i.source, summary: i.summary || '' })),
    },
    leads: g.leads.map((l) => ({
      id: String(l._id),
      at: iso(l.createdAt),
      title: l.title || '',
      stage: l.stage,
      stageName: (l.pipelineStageId && stageName.get(String(l.pipelineStageId))) || '',
      product: productName.get(String(l.productId || '')) || '',
      quantity: l.quantity ?? null,
      expectedValuePaise: l.expectedValuePaise ?? null,
      source: l.source || '',
      lostReason: l.lostReason || '',
      customFields: leadFields(l),
      activities: g.activities.filter((a) => String(a.leadId) === String(l._id) && a.text).map((a) => ({ at: iso(a.createdAt), text: a.text })),
      ...deleted(l),
    })),
    quotations: g.quotations.map((q) => ({
      number: q.number, type: q.type || 'Quotation', at: iso(q.quotationDate), status: q.status, totalPaise: q.totals?.grandTotalPaise || 0, items: items(q.items), billTo: party(q.billTo), ...deleted(q),
    })),
    orders: g.orders.map((o) => ({
      number: o.number, at: iso(o.orderDate), stage: o.stage, totalPaise: o.totals?.grandTotalPaise || 0, paidPaise: o.amountPaidPaise || 0, items: items(o.items), billTo: party(o.billTo),
      dispatch: o.dispatch?.dispatchedAt ? { at: iso(o.dispatch.dispatchedAt), transporter: o.dispatch.transporter || '', lrNumber: o.dispatch.lrNumber || '' } : null,
      deliveredAt: iso(o.deliveredAt), ...deleted(o),
    })),
    taxInvoices: g.invoices.map((i) => ({ number: i.number, kind: i.kind, at: iso(i.invoiceDate), totalPaise: i.totals?.grandTotalPaise || 0, billTo: party(i.billTo) })),
    payments: g.receipts.map((r) => ({ number: r.number, at: iso(r.receiptDate), amountPaise: r.amountPaise || 0, method: r.method || '', reference: r.reference || '', status: r.status })),
    paymentLinks: g.paymentLinks.map((l) => ({ at: iso(l.createdAt), amountPaise: l.amountPaise || 0, paidPaise: l.amountPaidPaise || 0, status: l.status, gateway: PAYMENT_PROVIDERS[l.provider] || l.provider, about: l.documentNumber || l.description || '' })),
    supportRequests: g.tickets.map((tk) => ({ number: tk.number, at: iso(tk.createdAt), subject: tk.subject || '', description: tk.description || '', status: tk.status, resolvedAt: iso(tk.resolvedAt), ...deleted(tk) })),
    tasks: g.tasks.map((tk) => ({ title: tk.title, dueDate: tk.dueDate || '', status: tk.status, ...deleted(tk) })),
    meetings: g.events.map((e) => ({ title: e.title, type: e.type || '', date: e.date, time: e.startTime || '', ...deleted(e) })),
    notes,
    calls: g.calls.map((call) => ({ at: iso(call.startedAt), direction: call.direction, durationSec: call.durationSec || 0, outcome: call.outcome || '', notes: call.notes || '' })),
    chats: g.conversations.map((chat) => ({ channel: chat.channel || 'whatsapp', startedAt: iso(chat.createdAt), messages: byChat.get(String(chat._id)) || [] })),
    sms: g.sms.map((s) => ({ at: iso(s.sentAt || s.createdAt), direction: s.direction, text: s.text || '', status: s.status })),
    emails: g.emails.map((e) => ({ at: iso(e.sentAt), direction: e.direction, from: e.from || '', to: e.to || [], subject: e.subject || '', snippet: e.snippet || '' })),
    files: g.documents.map((d) => ({ at: iso(d.createdAt), name: d.name, fileName: d.fileName || '', sizeBytes: d.sizeBytes || 0, link: d.linkUrl || '', ...deleted(d) })),
    campaigns: g.broadcasts.map((b) => ({ name: broadcastName.get(String(b.broadcastId)) || '', at: iso(b.sentAt || b.createdAt), status: b.status })),
    sequences: g.enrollments.map((e) => ({ name: e.sequenceName || '', status: e.status, at: iso(e.createdAt) })),
    scheduledMessages: g.scheduled.filter((s) => s.status === 'scheduled').map((s) => ({ at: iso(s.sendAt), text: s.text })),
    feedback: g.csat.filter((s) => s.rating).map((s) => ({ at: iso(s.answeredAt || s.askedAt), rating: s.rating })),
    linkedRecords: [
      ...g.projects.map((p) => ({ kind: 'project', name: p.name, status: p.status || '' })),
      ...g.records.map((r) => ({ kind: objectName.get(r.object) || r.object, name: r.name })),
    ],
    sharedWith: await sharedWith(organizationId, g, t, company),
  };
}

// POST /contacts/:id/privacy/export { format, language, askedAt } → { fileName, type, body }.
async function exportFile(req, id, { format = 'html', language = 'en', askedAt } = {}) {
  await privacy.assertMayHandle(req);
  const contact = await findContact(req, id);
  const asked = privacy.askedAtOf(askedAt);
  const t = textsFor(language);
  const data = await build(req, await gather(req.tenant.organizationId, contact), { askedAt: asked, t });
  await privacy.record(req, { type: 'access', contactId: contact._id, contactName: contact.name || '', askedAt: asked, format });
  await audit(req, { action: 'contact.data_exported', entityType: 'Contact', entityId: contact._id, changes: { format } });
  const day = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
  if (format === 'json') return { fileName: `customer-data-${day}.json`, type: 'application/json', body: JSON.stringify(data, null, 2) };
  return { fileName: `customer-data-${day}.html`, type: 'text/html', body: page.render(data, t) };
}

module.exports = { findContact, erasedError, gather, build, exportFile, messageOf };
