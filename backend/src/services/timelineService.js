const Message = require('../models/Message');
const Call = require('../models/Call');
const SmsMessage = require('../models/SmsMessage');
const EmailMessage = require('../models/EmailMessage');
const { visibleTo: emailsVisibleTo } = require('./gmailSyncService');
const Note = require('../models/Note');
const Lead = require('../models/Lead');
const LeadStageEvent = require('../models/LeadStageEvent');
const Quotation = require('../models/Quotation');
const Order = require('../models/Order');
const Ticket = require('../models/Ticket');
const Task = require('../models/Task');
const CalendarEvent = require('../models/CalendarEvent');
const ConsentEvent = require('../models/ConsentEvent');
const Touchpoint = require('../models/Touchpoint');
const Document = require('../models/Document');
const OrganizationMember = require('../models/OrganizationMember');
const httpError = require('../utils/httpError');
const { can } = require('../constants/permissions');
const { visibilityFilter, privacyFilter, assignedOrCreatedFilter } = require('./access');
const contactService = require('./contactService');

// One customer's history, newest first (Phase 6, D85): GET /contacts/:id/timeline. Every source
// is read with this member's own scope: the contact must be visible; WhatsApp needs the Inbox;
// deals, quotations and orders follow lead visibility; tasks, meetings, tickets and documents need
// their modules (and, for members who see only their own, theirs). No field edits: only what
// happened with the customer. Paged by a cursor of time and id, so nothing is skipped or repeated.
//   kinds: talk (WhatsApp, calls) · sales (deals, stage moves, quotations, orders, payments) ·
//          service (tickets) · work (tasks, meetings) · notes · other (enquiries, consent, documents)
const KINDS = Object.freeze({
  talk: ['whatsapp', 'call', 'sms', 'email'],
  sales: ['lead', 'stage', 'quotation', 'order', 'payment'],
  service: ['ticket'],
  work: ['task', 'event'],
  notes: ['note'],
  other: ['enquiry', 'consent', 'document'],
});
const LEAD_MODULES = ['leads', 'deals'];
const MAX_LIMIT = 100;

const clip = (text, max = 280) => (String(text || '').length > max ? `${String(text).slice(0, max - 1)}…` : String(text || ''));
const rupees = (paise) => `₹${(Math.round(Number(paise) || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// "2026-10-22T10:00:00.000Z_<id>" ↔ { at, id }
const encodeCursor = (item) => `${new Date(item.at).toISOString()}_${item.id}`;
function decodeCursor(cursor) {
  if (!cursor) return null;
  const [at, id = ''] = String(cursor).split('_');
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) throw httpError(400, 'VALIDATION_ERROR', 'The "before" cursor is not valid.');
  return { at: date, id };
}
// Strictly older than the cursor (same time: smaller id).
const olderThan = (cursor) => (item) => !cursor || item.at < cursor.at || (item.at.getTime() === cursor.at.getTime() && String(item.id) < cursor.id);

async function memberNames(organizationId) {
  const members = await OrganizationMember.find({ organizationId }).populate('userId', 'name email').lean();
  return new Map(members.map((m) => [String(m._id), m.displayName || m.userId?.name || m.userId?.email || '']));
}

// Each source: (ctx) → items { id, source, at, title, detail, … } at or before the cursor time.
const SOURCES = {
  async whatsapp({ req, contact, until, take }) {
    if (!can(req.member, 'inbox', 'view')) return [];
    // A WhatsApp call's line in the chat is left out: the call itself is in the history (G7).
    const messages = await Message.find({ organizationId: contact.organizationId, contactId: contact._id, type: { $ne: 'call' }, createdAt: { $lte: until }, ...privacyFilter(req) }).sort({ createdAt: -1, _id: -1 }).limit(take)
      .select('direction type text status createdAt sentByMemberId automation').lean();
    return messages.map((m) => ({
      id: String(m._id), source: 'whatsapp', at: m.createdAt, direction: m.direction, status: m.status,
      title: m.direction === 'in' ? 'WhatsApp from the customer' : 'WhatsApp sent',
      detail: clip(m.text || `[${m.type}]`), actorId: m.sentByMemberId || null, automation: Boolean(m.automation?.kind || m.automation?.ruleId),
    }));
  },
  async call({ contact, until, take }) {
    const calls = await Call.find({ organizationId: contact.organizationId, contactId: contact._id, startedAt: { $lte: until } }).sort({ startedAt: -1, _id: -1 }).limit(take).lean();
    return calls.map((c) => ({
      id: String(c._id), source: 'call', at: c.startedAt, direction: c.direction, status: c.status, outcome: c.outcome || null, durationSec: c.durationSec,
      // provider whatsapp: a WhatsApp call (G7, D111).
      provider: c.provider, title: `${c.provider === 'whatsapp' ? 'WhatsApp call' : 'Call'} ${c.direction === 'in' ? 'from' : 'to'} the customer`, detail: clip(c.notes), actorId: c.memberId || null,
    }));
  },
  // Synced Gmail (D90): shared emails, and the viewer's own private ones.
  async email({ req, contact, until, take }) {
    const messages = await EmailMessage.find({ ...emailsVisibleTo(req), contactIds: contact._id, sentAt: { $lte: until } }).sort({ sentAt: -1, _id: -1 }).limit(take).lean();
    return messages.map((m) => ({
      id: String(m._id), source: 'email', at: m.sentAt, direction: m.direction, threadId: m.threadId, name: m.subject || '',
      title: m.subject || '(no subject)', detail: clip(m.snippet, 600), actorId: m.memberId || null,
    }));
  },
  async sms({ contact, until, take }) {
    const messages = await SmsMessage.find({ organizationId: contact.organizationId, contactId: contact._id, createdAt: { $lte: until } }).sort({ createdAt: -1, _id: -1 }).limit(take).lean();
    return messages.map((m) => ({
      id: String(m._id), source: 'sms', at: m.createdAt, direction: m.direction, status: m.status, name: m.templateName || '',
      title: m.direction === 'in' ? 'SMS from the customer' : 'SMS sent', detail: clip(m.text, 600), actorId: m.memberId || null,
    }));
  },
  async note({ contact, until, take }) {
    const notes = await Note.find({ organizationId: contact.organizationId, parentType: 'contact', parentId: contact._id, createdAt: { $lte: until } }).sort({ createdAt: -1, _id: -1 }).limit(take).lean();
    return notes.map((n) => ({ id: String(n._id), source: 'note', at: n.createdAt, title: 'Note', detail: clip(n.text, 600), actorName: n.authorName || '' }));
  },
  async lead({ leads, until }) {
    return leads.filter((l) => l.createdAt <= until).map((l) => ({
      id: String(l._id), source: 'lead', at: l.createdAt, title: `Lead: ${l.title || 'Enquiry'}`, name: l.title || '', detail: [l.source, l.expectedValuePaise ? rupees(l.expectedValuePaise) : ''].filter(Boolean).join(' · '), leadId: String(l._id),
    }));
  },
  async stage({ contact, leads, until, take }) {
    if (!leads.length) return [];
    const titles = new Map(leads.map((l) => [String(l._id), l.title || 'Enquiry']));
    const events = await LeadStageEvent.find({ organizationId: contact.organizationId, leadId: { $in: leads.map((l) => l._id) }, source: { $ne: 'create' }, at: { $lte: until } }).sort({ at: -1, _id: -1 }).limit(take).lean();
    return events.map((e) => ({
      id: String(e._id), source: 'stage', at: e.at, title: `${titles.get(String(e.leadId))}: ${e.from.name || e.from.kind} → ${e.to.name || e.to.kind}`, name: `${titles.get(String(e.leadId))}: ${e.from.name || e.from.kind} → ${e.to.name || e.to.kind}`,
      detail: e.pipelineName || '', actorName: e.actorName || '', leadId: String(e.leadId),
    }));
  },
  async quotation({ req, contact, until, take }) {
    if (!LEAD_MODULES.some((m) => can(req.member, m, 'view'))) return [];
    const quotes = await Quotation.find({ organizationId: contact.organizationId, contactId: contact._id, createdAt: { $lte: until }, ...visibilityFilter(req, LEAD_MODULES) }).sort({ createdAt: -1, _id: -1 }).limit(take)
      .select('number type status totals createdAt sentAt acceptedAt').lean();
    return quotes.map((q) => ({
      id: String(q._id), source: 'quotation', at: q.createdAt, status: q.status, title: `${q.type || 'Quotation'} ${q.number || ''}`.trim(), name: [q.type && q.type !== 'Quotation' ? q.type : '', q.number || ''].filter(Boolean).join(' '), detail: `${rupees(q.totals?.grandTotalPaise)} · ${q.status}`,
    }));
  },
  async order({ req, contact, until, take }) {
    if (!LEAD_MODULES.some((m) => can(req.member, m, 'view'))) return [];
    const orders = await Order.find({ organizationId: contact.organizationId, contactId: contact._id, ...visibilityFilter(req, LEAD_MODULES), $or: [{ createdAt: { $lte: until } }, { 'payments.paidAt': { $lte: until } }] })
      .sort({ createdAt: -1 }).limit(take).select('number stage totals createdAt payments').lean();
    const items = [];
    for (const o of orders) {
      if (o.createdAt <= until) items.push({ id: String(o._id), source: 'order', at: o.createdAt, status: o.stage, title: `Order ${o.number || ''}`.trim(), name: o.number || '', detail: `${rupees(o.totals?.grandTotalPaise)} · ${o.stage}` });
      for (const p of o.payments || []) {
        if (p.paidAt && p.paidAt <= until) items.push({ id: String(p._id), source: 'payment', at: p.paidAt, title: `Payment for ${o.number || 'an order'}`, name: o.number || '', detail: [rupees(p.amountPaise), p.method].filter(Boolean).join(' · ') });
      }
    }
    return items;
  },
  async ticket({ req, contact, until, take }) {
    if (!can(req.member, 'support', 'view') && !can(req.member, 'customers', 'view')) return [];
    const tickets = await Ticket.find({ organizationId: contact.organizationId, contactId: contact._id, createdAt: { $lte: until }, ...assignedOrCreatedFilter(req, ['support', 'customers', 'reports']) })
      .sort({ createdAt: -1, _id: -1 }).limit(take).select('number subject status priority createdAt').lean();
    return tickets.map((t) => ({ id: String(t._id), source: 'ticket', at: t.createdAt, status: t.status, title: `Ticket #${t.number || ''}: ${t.subject || ''}`, name: `#${t.number || ''} ${t.subject || ''}`.trim(), detail: [t.status, t.priority].filter(Boolean).join(' · ') }));
  },
  async task({ req, contact, leads, until, take }) {
    if (!can(req.member, 'tasks', 'view')) return [];
    const tasks = await Task.find({ organizationId: contact.organizationId, ...relatedTo(contact, leads), createdAt: { $lte: until }, ...assignedOrCreatedFilter(req, ['tasks', 'calendar', 'deals', 'dashboard', 'customers', 'reports']) })
      .sort({ createdAt: -1, _id: -1 }).limit(take).select('title status dueDate createdAt').lean();
    return tasks.map((t) => ({ id: String(t._id), source: 'task', at: t.createdAt, status: t.status, title: `Task: ${t.title}`, name: t.title, due: t.dueDate || null, detail: [t.status, t.dueDate ? `due ${t.dueDate}` : ''].filter(Boolean).join(' · ') }));
  },
  async event({ req, contact, leads, until, take }) {
    if (!can(req.member, 'calendar', 'view') && !can(req.member, 'customers', 'view')) return [];
    const events = await CalendarEvent.find({ organizationId: contact.organizationId, ...relatedTo(contact, leads), createdAt: { $lte: until }, ...assignedOrCreatedFilter(req, ['calendar', 'dashboard', 'customers', 'reports']) })
      .sort({ createdAt: -1, _id: -1 }).limit(take).select('title type date startTime createdAt online').lean();
    return events.map((e) => ({ id: String(e._id), source: 'event', at: e.createdAt, title: `${e.type || 'Meeting'}: ${e.title}`, name: e.title, detail: `${e.date}${e.startTime ? ` ${e.startTime}` : ''}${e.online?.joinUrl ? ' · Teams' : ''}` }));
  },
  async enquiry({ contact, until, take }) {
    const touches = await Touchpoint.find({ organizationId: contact.organizationId, contactId: contact._id, at: { $lte: until } }).sort({ at: -1, _id: -1 }).limit(take).lean();
    return touches.map((t) => ({ id: String(t._id), source: 'enquiry', at: t.at, title: `Enquiry from ${t.source || 'a lead source'}`, name: t.source || '', detail: [t.channel, t.utm?.campaign].filter(Boolean).join(' · ') }));
  },
  async consent({ contact, until, take }) {
    const events = await ConsentEvent.find({ organizationId: contact.organizationId, contactId: contact._id, at: { $lte: until } }).sort({ at: -1, _id: -1 }).limit(take).lean();
    // channel: WhatsApp offers, or SMS (D88).
    return events.map((e) => ({ id: String(e._id), source: 'consent', channel: e.channel || 'whatsapp', at: e.at, title: `${e.channel === 'sms' ? 'SMS' : 'WhatsApp offers'}: ${e.from} → ${e.to}`, name: `${e.from} → ${e.to}`, detail: e.method || '', actorName: e.actorName || '' }));
  },
  async document({ req, contact, until, take }) {
    if (!can(req.member, 'documents', 'view') && !can(req.member, 'customers', 'view')) return [];
    const documents = await Document.find({ organizationId: contact.organizationId, relatedType: { $in: ['Customer', 'Contact'] }, relatedId: contact._id, createdAt: { $lte: until } }).sort({ createdAt: -1, _id: -1 }).limit(take).select('name category createdAt').lean();
    return documents.map((d) => ({ id: String(d._id), source: 'document', at: d.createdAt, title: `Document: ${d.name}`, name: d.name, detail: d.category || '' }));
  },
};

// Tasks and meetings linked to the customer or to one of their (visible) leads.
function relatedTo(contact, leads) {
  return { $or: [{ relatedType: { $in: ['Customer', 'Contact'] }, relatedId: contact._id }, ...(leads.length ? [{ relatedType: { $in: ['Lead', 'Deal'] }, relatedId: { $in: leads.map((l) => l._id) } }] : [])] };
}

async function timeline(req, contactId, { kinds, before, limit = 30 } = {}) {
  const contact = await contactService.findVisible(req, contactId);
  const take = Math.min(Math.max(Number(limit) || 30, 1), MAX_LIMIT);
  const cursor = decodeCursor(before);
  const until = cursor ? cursor.at : new Date(8.64e15);
  const wanted = (kinds?.length ? kinds : Object.keys(KINDS)).flatMap((kind) => KINDS[kind] || []);
  const leads = LEAD_MODULES.some((m) => can(req.member, m, 'view'))
    ? await Lead.find({ organizationId: contact.organizationId, contactId: contact._id, ...visibilityFilter(req, LEAD_MODULES), ...privacyFilter(req) }).select('title source expectedValuePaise createdAt').limit(500).lean()
    : [];
  // One more than a page from each source, so the merge knows whether more exist.
  // Payments come with their orders: each reader runs once, then only the wanted kinds stay.
  const readers = [...new Set(wanted.map((source) => (source === 'payment' ? 'order' : source)))];
  const lists = await Promise.all(readers.map((source) => SOURCES[source]({ req, contact, leads, until, take: take + 1 })));
  const merged = lists.flat()
    .filter((item) => wanted.includes(item.source))
    .map((item) => ({ ...item, at: new Date(item.at) }))
    .filter(olderThan(cursor))
    .sort((a, b) => b.at - a.at || (String(b.id) > String(a.id) ? 1 : -1));
  const page = merged.slice(0, take);
  const names = await memberNames(contact.organizationId);
  const items = page.map(({ actorId, ...item }) => ({
    ...item,
    kind: Object.keys(KINDS).find((kind) => KINDS[kind].includes(item.source)),
    actorName: item.actorName || (actorId ? names.get(String(actorId)) || '' : item.automation ? 'Automation' : ''),
  }));
  return { items, next: merged.length > take ? encodeCursor(page[page.length - 1]) : null };
}

module.exports = { timeline, KINDS, encodeCursor, decodeCursor };
