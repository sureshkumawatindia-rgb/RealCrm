const mongoose = require('mongoose');
const Broadcast = require('../models/Broadcast');
const Contact = require('../models/Contact');
const Conversation = require('../models/Conversation');
const Lead = require('../models/Lead');
const LeadIntake = require('../models/LeadIntake');
const Message = require('../models/Message');
const Order = require('../models/Order');
const OrganizationMember = require('../models/OrganizationMember');
const PaymentLink = require('../models/PaymentLink');
const Quotation = require('../models/Quotation');
const Task = require('../models/Task');
const Ticket = require('../models/Ticket');
const { isManager, canViewAll } = require('../constants/permissions');
const { LEAD_STAGES, OPEN_STAGES, LEAD_SOURCES, STAGE_PROBABILITY } = require('../constants/crm');
const { rangeOf, bucketOf, bucketsOf, istDay, dayStart, DAY_MS } = require('../utils/reportRange');
const { indiaDate } = require('../utils/dates');
const { statsOf } = require('./broadcastService');

// Reports (Phase 9): counted from the records when asked (D47), for a range of calendar days in
// India. Owners, admins and members with "reports: see all" see the whole company; everyone else
// their own leads, quotations, orders, chats and work (D45). Response times run from a customer's
// first unanswered message to a teammate's reply; bot and automatic messages do not count (D46).
const MAX_MESSAGES = 100000;
const HOUR = 60 * 60 * 1000;
const { ObjectId } = mongoose.Types;

// --- who sees what ----------------------------------------------------------------------
function seesAll(req, module = 'reports') {
  return isManager(req.member) || canViewAll(req.member, module) || canViewAll(req.member, 'reports');
}
// null = the whole company; else the member whose numbers these are.
const ownOnly = (req, module) => (seesAll(req, module) ? null : req.member._id);
const orgId = (req) => new ObjectId(String(req.tenant.organizationId));
const between = (range) => ({ $gte: range.start, $lt: range.end });
const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
};
const average = (values) => (values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : null);
const sum = (rows, field) => rows.reduce((total, row) => total + (row[field] || 0), 0);

async function memberNames(organizationId) {
  const members = await OrganizationMember.find({ organizationId }).populate('userId', 'name email');
  return new Map(members.map((m) => [String(m._id), { id: m._id, name: m.displayName || m.userId?.name || m.userId?.email || 'Member', role: m.role, status: m.status }]));
}

// A lead's value: what was expected, else its latest sent quotation's total.
async function leadValues(organizationId, leads) {
  const missing = leads.filter((l) => !l.expectedValuePaise).map((l) => l._id);
  const quotes = missing.length
    ? await Quotation.find({ organizationId, leadId: { $in: missing }, status: { $in: ['Sent', 'Viewed', 'Accepted', 'Draft'] } }).select('leadId totals.grandTotalPaise sentAt createdAt').sort({ createdAt: -1 })
    : [];
  const latest = new Map();
  for (const q of quotes) if (!latest.has(String(q.leadId))) latest.set(String(q.leadId), q.totals?.grandTotalPaise || 0);
  return (lead) => lead.expectedValuePaise || latest.get(String(lead._id)) || 0;
}

// Payments received in the range (on orders), with the order's owner.
async function paymentsIn(req, range, own) {
  return Order.aggregate([
    { $match: { organizationId: orgId(req), deletedAt: null, 'payments.paidAt': between(range), ...(own && { ownerId: own }) } },
    { $unwind: '$payments' },
    { $match: { 'payments.paidAt': between(range) } },
    { $project: { ownerId: 1, orderId: '$_id', number: 1, amountPaise: '$payments.amountPaise', paidAt: '$payments.paidAt', source: '$payments.source', method: '$payments.method', provider: '$payments.provider' } },
  ]);
}

// What is still due now (not cancelled, not marked collected), by how long it has waited.
async function duesNow(req, own) {
  const orders = await Order.find({
    organizationId: req.tenant.organizationId, stage: { $nin: ['Cancelled', 'Payment Collected'] }, ...(own && { ownerId: own }),
    $expr: { $lt: [{ $ifNull: ['$amountPaidPaise', 0] }, { $ifNull: ['$totals.grandTotalPaise', 0] }] },
  }).select('orderDate createdAt amountPaidPaise totals.grandTotalPaise');
  const buckets = { '0-7': { count: 0, duePaise: 0 }, '8-30': { count: 0, duePaise: 0 }, '31-60': { count: 0, duePaise: 0 }, '60+': { count: 0, duePaise: 0 } };
  let total = 0;
  for (const o of orders) {
    const due = (o.totals?.grandTotalPaise || 0) - (o.amountPaidPaise || 0);
    const days = Math.floor((Date.now() - new Date(o.orderDate || o.createdAt).getTime()) / DAY_MS);
    const key = days <= 7 ? '0-7' : days <= 30 ? '8-30' : days <= 60 ? '31-60' : '60+';
    buckets[key].count += 1;
    buckets[key].duePaise += due;
    total += due;
  }
  return { count: orders.length, duePaise: total, buckets };
}

// --- response times (D46) ------------------------------------------------------------------
// Walks the messages of the range (and a week before, to know who was waiting): each customer
// message that nobody answered yet starts the clock; a teammate's message stops it.
async function responseTurns(req, range, own) {
  const scanStart = new Date(range.start.getTime() - 7 * DAY_MS);
  const messages = await Message.find({
    organizationId: req.tenant.organizationId, createdAt: { $gte: scanStart, $lt: range.end },
  }).select('conversationId direction createdAt providerTimestamp sentByMemberId automation').sort({ conversationId: 1, createdAt: 1 }).limit(MAX_MESSAGES).lean();
  const turns = []; // { memberId, conversationId, seconds, first }
  const handled = new Map(); // member → Set(conversation)
  const sent = new Map(); // member → messages sent in the range
  const firstInbound = new Map(); // conversation → first customer message seen
  let current = null;
  let waitingSince = null;
  let answered = false;
  for (const m of messages) {
    const conversation = String(m.conversationId);
    if (conversation !== current) {
      current = conversation;
      waitingSince = null;
      answered = false;
    }
    const at = new Date(m.direction === 'in' ? m.providerTimestamp || m.createdAt : m.createdAt);
    if (m.direction === 'in') {
      if (!firstInbound.has(conversation)) firstInbound.set(conversation, at);
      if (!waitingSince) waitingSince = at;
      continue;
    }
    if (!m.sentByMemberId) continue; // the bot, an auto-reply, a broadcast: the customer still waits for a person
    const member = String(m.sentByMemberId);
    const inRange = at >= range.start && at < range.end;
    if (inRange) {
      if (!handled.has(member)) handled.set(member, new Set());
      handled.get(member).add(conversation);
      sent.set(member, (sent.get(member) || 0) + 1);
      if (waitingSince) turns.push({ memberId: member, conversationId: conversation, seconds: Math.max(Math.round((at - waitingSince) / 1000), 0), first: !answered && firstInbound.get(conversation) === waitingSince });
    }
    waitingSince = null;
    answered = true;
  }
  // A "first" response only for chats that began inside the scan (older chats began earlier).
  const candidates = [...new Set(turns.filter((t) => t.first).map((t) => t.conversationId))];
  if (candidates.length) {
    const fresh = new Set((await Conversation.find({ _id: { $in: candidates }, createdAt: { $gte: scanStart } }).select('_id').lean()).map((c) => String(c._id)));
    for (const t of turns) if (t.first && !fresh.has(t.conversationId)) t.first = false;
  }
  const mine = (member) => !own || member === String(own);
  return {
    turns: turns.filter((t) => mine(t.memberId)),
    handled: new Map([...handled].filter(([member]) => mine(member))),
    sent: new Map([...sent].filter(([member]) => mine(member))),
    truncated: messages.length === MAX_MESSAGES,
  };
}

// --- overview ------------------------------------------------------------------------------
async function overview(req, query) {
  const range = rangeOf(query);
  const organizationId = req.tenant.organizationId;
  const own = ownOnly(req, 'leads');
  const owner = own ? { ownerId: own } : {};
  const [created, won, lost, quotesSent, quotesAccepted, orders, payments, newCustomers, openLeads, dues, newChats, inbound, response, ticketsCreated, ticketsResolved] = await Promise.all([
    Lead.countDocuments({ organizationId, createdAt: between(range), ...owner }),
    Lead.countDocuments({ organizationId, stage: 'Won', stageChangedAt: between(range), ...owner }),
    Lead.countDocuments({ organizationId, stage: 'Lost', stageChangedAt: between(range), ...owner }),
    Quotation.countDocuments({ organizationId, sentAt: between(range), ...owner }),
    Quotation.countDocuments({ organizationId, status: 'Accepted', acceptedAt: between(range), ...owner }),
    Order.find({ organizationId, createdAt: between(range), stage: { $ne: 'Cancelled' }, ...owner }).select('totals.grandTotalPaise'),
    paymentsIn(req, range, own),
    Contact.countDocuments({ organizationId, becameCustomerAt: between(range), ...owner }),
    Lead.find({ organizationId, stage: { $in: OPEN_STAGES }, ...owner }).select('expectedValuePaise stage'),
    duesNow(req, own),
    Conversation.countDocuments({ organizationId, createdAt: between(range), ...(own && { assigneeId: own }) }),
    own ? Promise.resolve(null) : Message.countDocuments({ organizationId, direction: 'in', createdAt: between(range) }),
    responseTurns(req, range, own),
    Ticket.countDocuments({ organizationId, createdAt: between(range), ...(own && { assigneeId: own }) }),
    Ticket.countDocuments({ organizationId, resolvedAt: between(range), ...(own && { assigneeId: own }) }),
  ]);
  const valueOf = await leadValues(organizationId, openLeads);
  const seconds = response.turns.map((t) => t.seconds);
  const firsts = response.turns.filter((t) => t.first).map((t) => t.seconds);
  return {
    range: { from: range.from, to: range.to, days: range.days },
    scope: own ? 'own' : 'company',
    leads: { created, won, lost, winRatePct: pct(won, won + lost) },
    quotations: { sent: quotesSent, accepted: quotesAccepted },
    orders: { count: orders.length, valuePaise: orders.reduce((s, o) => s + (o.totals?.grandTotalPaise || 0), 0) },
    payments: { collectedPaise: sum(payments, 'amountPaise'), count: payments.length },
    customers: { new: newCustomers },
    pipeline: { open: openLeads.length, valuePaise: openLeads.reduce((s, l) => s + valueOf(l), 0), weightedPaise: openLeads.reduce((s, l) => s + Math.round((valueOf(l) * (STAGE_PROBABILITY[l.stage] || 0)) / 100), 0) },
    dues: { orders: dues.count, duePaise: dues.duePaise },
    whatsapp: {
      newChats, inboundMessages: inbound, replies: seconds.length,
      firstResponseMedianSeconds: median(firsts), responseMedianSeconds: median(seconds), responseAverageSeconds: average(seconds),
    },
    tickets: { created: ticketsCreated, resolved: ticketsResolved },
  };
}

// --- trend: one series per bucket ----------------------------------------------------------
async function trend(req, query) {
  const range = rangeOf(query);
  const organizationId = req.tenant.organizationId;
  const own = ownOnly(req, 'leads');
  const owner = own ? { ownerId: own } : {};
  const [leads, won, orders, payments] = await Promise.all([
    Lead.find({ organizationId, createdAt: between(range), ...owner }).select('createdAt').lean(),
    Lead.find({ organizationId, stage: 'Won', stageChangedAt: between(range), ...owner }).select('stageChangedAt').lean(),
    Order.find({ organizationId, createdAt: between(range), stage: { $ne: 'Cancelled' }, ...owner }).select('createdAt totals.grandTotalPaise').lean(),
    paymentsIn(req, range, own),
  ]);
  const keys = bucketsOf(range);
  const rows = new Map(keys.map((key) => [key, { bucket: key, leads: 0, won: 0, orders: 0, orderValuePaise: 0, collectedPaise: 0 }]));
  const at = (date) => rows.get(bucketOf(date, range.unit));
  for (const l of leads) if (at(l.createdAt)) at(l.createdAt).leads += 1;
  for (const l of won) if (at(l.stageChangedAt)) at(l.stageChangedAt).won += 1;
  for (const o of orders) {
    const row = at(o.createdAt);
    if (row) {
      row.orders += 1;
      row.orderValuePaise += o.totals?.grandTotalPaise || 0;
    }
  }
  for (const p of payments) if (at(p.paidAt)) at(p.paidAt).collectedPaise += p.amountPaise || 0;
  return { range: { from: range.from, to: range.to, unit: range.unit }, items: [...rows.values()] };
}

// --- agent performance -------------------------------------------------------------------
async function agents(req, query) {
  const range = rangeOf(query);
  const organizationId = req.tenant.organizationId;
  const own = ownOnly(req, 'reports');
  const match = (field) => ({ organizationId: orgId(req), deletedAt: null, ...(own && { [field]: own }) });
  const group = (Model, filter, idField, extra = {}) => Model.aggregate([{ $match: filter }, { $group: { _id: `$${idField}`, count: { $sum: 1 }, ...extra } }]);
  const [names, response, leadStages, leadsCreated, leadsWon, leadsLost, quotesSent, quotesAccepted, orders, payments, tasksDone, ticketsResolved] = await Promise.all([
    memberNames(organizationId),
    responseTurns(req, range, own),
    Lead.aggregate([{ $match: { ...match('ownerId') } }, { $group: { _id: { owner: '$ownerId', stage: '$stage' }, count: { $sum: 1 } } }]),
    group(Lead, { ...match('ownerId'), createdAt: between(range) }, 'ownerId'),
    group(Lead, { ...match('ownerId'), stage: 'Won', stageChangedAt: between(range) }, 'ownerId'),
    group(Lead, { ...match('ownerId'), stage: 'Lost', stageChangedAt: between(range) }, 'ownerId'),
    group(Quotation, { ...match('ownerId'), sentAt: between(range) }, 'ownerId'),
    group(Quotation, { ...match('ownerId'), status: 'Accepted', acceptedAt: between(range) }, 'ownerId'),
    group(Order, { ...match('ownerId'), createdAt: between(range), stage: { $ne: 'Cancelled' } }, 'ownerId', { valuePaise: { $sum: '$totals.grandTotalPaise' } }),
    paymentsIn(req, range, own),
    group(Task, { ...match('assigneeId'), status: 'Done', completedAt: between(range) }, 'assigneeId'),
    group(Ticket, { ...match('assigneeId'), resolvedAt: between(range) }, 'assigneeId'),
  ]);
  const rows = new Map();
  const row = (id) => {
    const key = String(id);
    if (!rows.has(key)) {
      const member = names.get(key);
      rows.set(key, {
        memberId: key, name: member?.name || 'Former member', role: member?.role || '', active: member?.status === 'active',
        chatsHandled: 0, messagesSent: 0, replies: 0, firstResponseMedianSeconds: null, responseMedianSeconds: null, responseAverageSeconds: null,
        leadsByStage: Object.fromEntries(LEAD_STAGES.map((s) => [s, 0])), leadsCreated: 0, won: 0, lost: 0, winRatePct: 0,
        quotationsSent: 0, quotationsAccepted: 0, orders: 0, orderValuePaise: 0, collectedPaise: 0, tasksDone: 0, ticketsResolved: 0,
      });
    }
    return rows.get(key);
  };
  // Every active member appears (also with nothing to show); others only with activity.
  for (const [key, member] of names) if (member.status === 'active' && (!own || key === String(own))) row(key);
  const into = (list, field, valueField = 'count') => list.forEach((r) => { if (r._id) row(r._id)[field] += r[valueField] || 0; });
  for (const r of leadStages) if (r._id.owner) row(r._id.owner).leadsByStage[r._id.stage] += r.count;
  into(leadsCreated, 'leadsCreated');
  into(leadsWon, 'won');
  into(leadsLost, 'lost');
  into(quotesSent, 'quotationsSent');
  into(quotesAccepted, 'quotationsAccepted');
  into(orders, 'orders');
  into(orders, 'orderValuePaise', 'valuePaise');
  into(tasksDone, 'tasksDone');
  into(ticketsResolved, 'ticketsResolved');
  for (const p of payments) if (p.ownerId) row(p.ownerId).collectedPaise += p.amountPaise || 0;
  for (const [member, chats] of response.handled) row(member).chatsHandled = chats.size;
  for (const [member, count] of response.sent) row(member).messagesSent = count;
  const byMember = new Map();
  for (const t of response.turns) {
    if (!byMember.has(t.memberId)) byMember.set(t.memberId, []);
    byMember.get(t.memberId).push(t);
  }
  for (const [member, turns] of byMember) {
    const r = row(member);
    const seconds = turns.map((t) => t.seconds);
    r.replies = seconds.length;
    r.responseMedianSeconds = median(seconds);
    r.responseAverageSeconds = average(seconds);
    r.firstResponseMedianSeconds = median(turns.filter((t) => t.first).map((t) => t.seconds));
  }
  const items = [...rows.values()]
    .map((r) => ({ ...r, winRatePct: pct(r.won, r.won + r.lost) }))
    .filter((r) => !own || r.memberId === String(own))
    .sort((a, b) => b.collectedPaise - a.collectedPaise || b.won - a.won || a.name.localeCompare(b.name));
  const seconds = response.turns.map((t) => t.seconds);
  return {
    range: { from: range.from, to: range.to, days: range.days },
    scope: own ? 'own' : 'company',
    items,
    team: {
      chatsHandled: new Set(response.turns.map((t) => t.conversationId)).size,
      replies: seconds.length,
      responseMedianSeconds: median(seconds),
      responseAverageSeconds: average(seconds),
      firstResponseMedianSeconds: median(response.turns.filter((t) => t.first).map((t) => t.seconds)),
      won: sum(items, 'won'),
      orderValuePaise: sum(items, 'orderValuePaise'),
      collectedPaise: sum(items, 'collectedPaise'),
    },
    truncated: response.truncated,
  };
}

// --- where leads come from, and how far they get -------------------------------------------
async function sources(req, query) {
  const range = rangeOf(query);
  const own = ownOnly(req, 'leads');
  const [stages, enquiries] = await Promise.all([
    Lead.aggregate([
      { $match: { organizationId: orgId(req), deletedAt: null, createdAt: between(range), ...(own && { ownerId: own }) } },
      { $group: { _id: { source: '$source', stage: '$stage' }, count: { $sum: 1 } } },
    ]),
    own ? [] : LeadIntake.aggregate([
      { $match: { organizationId: orgId(req), receivedAt: between(range) } },
      { $group: { _id: { source: '$source', outcome: '$outcome' }, count: { $sum: 1 } } },
    ]),
  ]);
  const rows = new Map();
  const row = (source) => {
    if (!rows.has(source)) rows.set(source, { source, enquiries: 0, repeatEnquiries: 0, rejected: 0, leads: 0, byStage: Object.fromEntries(LEAD_STAGES.map((s) => [s, 0])) });
    return rows.get(source);
  };
  for (const r of stages) {
    const target = row(r._id.source || 'Manual');
    target.leads += r.count;
    target.byStage[r._id.stage] += r.count;
  }
  for (const r of enquiries) {
    const target = row(r._id.source || 'Manual');
    target.enquiries += r.count;
    if (r._id.outcome === 'attached') target.repeatEnquiries += r.count;
    if (r._id.outcome === 'rejected') target.rejected += r.count;
  }
  const order = (source) => (LEAD_SOURCES.includes(source) ? LEAD_SOURCES.indexOf(source) : 99);
  const items = [...rows.values()].map((r) => {
    const reached = (stages) => stages.reduce((total, stage) => total + r.byStage[stage], 0);
    return {
      ...r,
      // How far the leads of the range have got now (a lead at Negotiation passed Contacted …).
      funnel: {
        created: r.leads,
        contacted: reached(['Contacted', 'Quote Sent', 'Negotiation', 'Won']),
        quoted: reached(['Quote Sent', 'Negotiation', 'Won']),
        won: r.byStage.Won,
      },
      conversionPct: pct(r.byStage.Won, r.leads),
    };
  }).sort((a, b) => b.leads - a.leads || order(a.source) - order(b.source));
  const totals = { enquiries: sum(items, 'enquiries'), leads: sum(items, 'leads'), won: items.reduce((s, r) => s + r.byStage.Won, 0) };
  return { range: { from: range.from, to: range.to, days: range.days }, scope: own ? 'own' : 'company', items, totals: { ...totals, conversionPct: pct(totals.won, totals.leads) } };
}

// --- quotations: how many are won ------------------------------------------------------------
async function quotations(req, query) {
  const range = rangeOf(query);
  const organizationId = req.tenant.organizationId;
  const own = ownOnly(req, 'leads');
  const [names, sent] = await Promise.all([
    memberNames(organizationId),
    Quotation.find({ organizationId, sentAt: between(range), ...(own && { ownerId: own }) }).select('type status ownerId sentAt viewedAt acceptedAt rejectedReason totals.grandTotalPaise').lean(),
  ]);
  const summarize = (list) => {
    const accepted = list.filter((q) => q.status === 'Accepted');
    const rejected = list.filter((q) => q.status === 'Rejected');
    const days = accepted.filter((q) => q.acceptedAt).map((q) => (new Date(q.acceptedAt) - new Date(q.sentAt)) / DAY_MS);
    return {
      sent: list.length,
      viewed: list.filter((q) => q.viewedAt).length,
      accepted: accepted.length,
      rejected: rejected.length,
      expired: list.filter((q) => q.status === 'Expired').length,
      open: list.filter((q) => ['Sent', 'Viewed'].includes(q.status)).length,
      winRatePct: pct(accepted.length, list.length),
      viewedPct: pct(list.filter((q) => q.viewedAt).length, list.length),
      sentValuePaise: list.reduce((s, q) => s + (q.totals?.grandTotalPaise || 0), 0),
      acceptedValuePaise: accepted.reduce((s, q) => s + (q.totals?.grandTotalPaise || 0), 0),
      averageDaysToAccept: days.length ? Math.round((days.reduce((s, d) => s + d, 0) / days.length) * 10) / 10 : null,
    };
  };
  const owners = new Map();
  for (const q of sent) {
    const key = q.ownerId ? String(q.ownerId) : '';
    if (!owners.has(key)) owners.set(key, []);
    owners.get(key).push(q);
  }
  const reasons = new Map();
  for (const q of sent) {
    if (q.status !== 'Rejected') continue;
    const reason = String(q.rejectedReason || '').trim() || 'No reason given';
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }
  return {
    range: { from: range.from, to: range.to, days: range.days },
    scope: own ? 'own' : 'company',
    totals: summarize(sent),
    byOwner: [...owners].map(([key, list]) => ({ memberId: key || null, name: key ? names.get(key)?.name || 'Former member' : 'Nobody', ...summarize(list) })).sort((a, b) => b.sent - a.sent),
    rejectionReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 10),
  };
}

// --- broadcasts (owners and admins, D36) ------------------------------------------------------
async function broadcasts(req, query) {
  const range = rangeOf(query);
  if (!isManager(req.member)) return { range: { from: range.from, to: range.to, days: range.days }, items: [], totals: null };
  const list = await Broadcast.find({ organizationId: req.tenant.organizationId, startedAt: between(range) }).sort({ startedAt: -1 }).limit(500);
  const stats = await statsOf(list.map((b) => b._id));
  const rate = (s) => ({ deliveredPct: pct(s.delivered, s.sent), readPct: pct(s.read, s.delivered), repliedPct: pct(s.replied, s.delivered), failedPct: pct(s.failed, s.total) });
  const items = list.map((b) => {
    const s = stats.get(String(b._id)) || stats.get('empty');
    return { id: b._id, name: b.name, status: b.status, templateName: b.templateName, category: b.category, segmentName: b.segmentName, startedAt: b.startedAt, ...s, ...rate(s) };
  });
  const totals = ['total', 'sent', 'delivered', 'read', 'replied', 'failed', 'skipped'].reduce((t, f) => ({ ...t, [f]: sum(items, f) }), { broadcasts: items.length });
  return { range: { from: range.from, to: range.to, days: range.days }, items, totals: { ...totals, ...rate(totals) } };
}

// --- payment collection -------------------------------------------------------------------
async function payments(req, query) {
  const range = rangeOf(query);
  const organizationId = req.tenant.organizationId;
  const own = ownOnly(req, 'leads');
  const owner = own ? { ownerId: own } : {};
  const [received, linksMade, linksPaid, paidOrders, dues] = await Promise.all([
    paymentsIn(req, range, own),
    PaymentLink.countDocuments({ organizationId, createdAt: between(range), ...owner }),
    PaymentLink.find({ organizationId, status: 'paid', paidAt: between(range), ...owner }).select('createdAt paidAt').lean(),
    Order.find({ organizationId, paidAt: between(range), ...owner }).select('orderDate createdAt paidAt').lean(),
    duesNow(req, own),
  ]);
  const by = (key) => {
    const groups = new Map();
    for (const p of received) {
      const name = key(p);
      const g = groups.get(name) || { name, count: 0, amountPaise: 0 };
      g.count += 1;
      g.amountPaise += p.amountPaise || 0;
      groups.set(name, g);
    }
    return [...groups.values()].sort((a, b) => b.amountPaise - a.amountPaise);
  };
  const METHOD = { cash: 'Cash', bank_transfer: 'Bank transfer', upi: 'UPI', cheque: 'Cheque', card: 'Card', netbanking: 'Net banking', wallet: 'Wallet', emi: 'EMI', other: 'Other' };
  const PROVIDER = { razorpay: 'Razorpay', cashfree: 'Cashfree', mock: 'Test gateway' };
  const keys = bucketsOf(range);
  const series = new Map(keys.map((k) => [k, { bucket: k, amountPaise: 0, count: 0 }]));
  for (const p of received) {
    const row = series.get(bucketOf(p.paidAt, range.unit));
    if (row) {
      row.amountPaise += p.amountPaise || 0;
      row.count += 1;
    }
  }
  const hoursToPay = linksPaid.map((l) => (new Date(l.paidAt) - new Date(l.createdAt)) / HOUR);
  const daysToCollect = paidOrders.map((o) => (new Date(o.paidAt) - new Date(o.orderDate || o.createdAt)) / DAY_MS);
  return {
    range: { from: range.from, to: range.to, days: range.days, unit: range.unit },
    scope: own ? 'own' : 'company',
    collected: { amountPaise: sum(received, 'amountPaise'), count: received.length },
    byWay: by((p) => (p.source === 'link' ? `Payment link · ${PROVIDER[p.provider] || p.provider}` : `By hand · ${METHOD[p.method] || 'Other'}`)),
    byMethod: by((p) => METHOD[p.method] || (p.source === 'link' ? 'Online' : 'Other')),
    trend: [...series.values()],
    links: {
      made: linksMade,
      paid: linksPaid.length,
      averageHoursToPay: hoursToPay.length ? Math.round((hoursToPay.reduce((s, h) => s + h, 0) / hoursToPay.length) * 10) / 10 : null,
    },
    ordersPaidInFull: paidOrders.length,
    averageDaysToCollect: daysToCollect.length ? Math.round((daysToCollect.reduce((s, d) => s + d, 0) / daysToCollect.length) * 10) / 10 : null,
    dues,
  };
}

// --- the dashboard: today and this month --------------------------------------------------
async function dashboard(req) {
  const organizationId = req.tenant.organizationId;
  const own = ownOnly(req, 'leads');
  const owner = own ? { ownerId: own } : {};
  const today = indiaDate(0);
  const todayRange = { start: dayStart(today), end: new Date(dayStart(today).getTime() + DAY_MS) };
  const month = { start: dayStart(`${today.slice(0, 7)}-01`), end: todayRange.end };
  const chatScope = own ? { $or: [{ assigneeId: own }, { assigneeId: null }] } : {};
  const [leadsToday, leadsMonth, wonMonth, waiting, unassigned, openLeads, payments, dues, tasksToday, tasksOverdue, quotesWaiting] = await Promise.all([
    Lead.countDocuments({ organizationId, createdAt: between(todayRange), ...owner }),
    Lead.countDocuments({ organizationId, createdAt: between(month), ...owner }),
    Lead.countDocuments({ organizationId, stage: 'Won', stageChangedAt: between(month), ...owner }),
    Conversation.find({ organizationId, status: { $ne: 'closed' }, lastMessageDirection: 'in', ...chatScope }).select('lastInboundAt').lean(),
    Conversation.countDocuments({ organizationId, status: { $ne: 'closed' }, assigneeId: null }),
    Lead.find({ organizationId, stage: { $in: OPEN_STAGES }, ...owner }).select('expectedValuePaise stage'),
    paymentsIn(req, month, own),
    duesNow(req, own),
    Task.countDocuments({ organizationId, status: { $ne: 'Done' }, dueDate: today, ...(own && { assigneeId: own }) }),
    Task.countDocuments({ organizationId, status: { $ne: 'Done' }, dueDate: { $lt: today, $gt: '' }, ...(own && { assigneeId: own }) }),
    Quotation.countDocuments({ organizationId, status: { $in: ['Sent', 'Viewed'] }, sentAt: { $lte: new Date(Date.now() - 3 * DAY_MS) }, ...owner }),
  ]);
  const valueOf = await leadValues(organizationId, openLeads);
  const longest = waiting.reduce((oldest, c) => (c.lastInboundAt && (!oldest || c.lastInboundAt < oldest) ? c.lastInboundAt : oldest), null);
  return {
    today,
    scope: own ? 'own' : 'company',
    leads: { today: leadsToday, month: leadsMonth, wonMonth },
    chats: { waitingForReply: waiting.length, unassigned, longestWaitMinutes: longest ? Math.round((Date.now() - new Date(longest).getTime()) / 60000) : null },
    pipeline: { open: openLeads.length, valuePaise: openLeads.reduce((s, l) => s + valueOf(l), 0) },
    quotations: { waitingThreeDays: quotesWaiting },
    payments: { collectedMonthPaise: sum(payments, 'amountPaise'), dueOrders: dues.count, duePaise: dues.duePaise },
    tasks: { dueToday: tasksToday, overdue: tasksOverdue },
  };
}

// --- insights (the AI Insights page): what needs attention, from the records ----------------
const NEXT_STEP = {
  New: 'Call or message today to qualify', Contacted: 'Send a quotation', 'Quote Sent': 'Follow up on the quotation', Negotiation: 'Close: send a payment link',
};
async function insights(req) {
  const organizationId = req.tenant.organizationId;
  const own = ownOnly(req, 'leads');
  const owner = own ? { ownerId: own } : {};
  const now = Date.now();
  const [names, open, closed90, slowChats, dues, overview90] = await Promise.all([
    memberNames(organizationId),
    Lead.find({ organizationId, stage: { $in: OPEN_STAGES }, ...owner }).populate('contactId', 'name company').select('title stage source ownerId expectedValuePaise lastActivityAt createdAt contactId lastQuoteSentAt lastCustomerReplyAt').lean(),
    Lead.find({ organizationId, stage: { $in: ['Won', 'Lost'] }, stageChangedAt: { $gte: new Date(now - 90 * DAY_MS) }, ...owner }).select('stage').lean(),
    Conversation.find({ organizationId, status: { $ne: 'closed' }, lastMessageDirection: 'in', lastInboundAt: { $lte: new Date(now - 2 * HOUR) }, ...(own && { $or: [{ assigneeId: own }, { assigneeId: null }] }) })
      .populate('contactId', 'name').select('lastInboundAt assigneeId contactId').sort({ lastInboundAt: 1 }).limit(20).lean(),
    duesNow(req, own),
    overview(req, { from: indiaDate(-89), to: indiaDate(0) }),
  ]);
  const valueOf = await leadValues(organizationId, open);
  const idle = (lead) => Math.floor((now - new Date(lead.lastActivityAt || lead.createdAt).getTime()) / DAY_MS);
  const leadRow = (l) => ({
    id: l._id, title: l.title || 'Enquiry', customer: l.contactId?.name || '', company: l.contactId?.company || '', stage: l.stage, source: l.source,
    owner: l.ownerId ? names.get(String(l.ownerId))?.name || '' : '', ownerId: l.ownerId || null,
    valuePaise: valueOf(l), probability: STAGE_PROBABILITY[l.stage] || 0, idleDays: idle(l), nextStep: NEXT_STEP[l.stage] || '',
  });
  const rows = open.map(leadRow);
  const atRisk = rows.filter((r) => r.idleDays >= 14 || (r.stage === 'Quote Sent' && r.idleDays >= 7));
  const negotiation = rows.filter((r) => r.stage === 'Negotiation');
  const won = closed90.filter((l) => l.stage === 'Won').length;
  return {
    pipeline: {
      open: rows.length,
      valuePaise: sum(rows, 'valuePaise'),
      weightedPaise: rows.reduce((s, r) => s + Math.round((r.valuePaise * r.probability) / 100), 0),
      byStage: OPEN_STAGES.map((stage) => ({ stage, count: rows.filter((r) => r.stage === stage).length, valuePaise: sum(rows.filter((r) => r.stage === stage), 'valuePaise') })),
    },
    atRisk: { count: atRisk.length, valuePaise: sum(atRisk, 'valuePaise'), items: atRisk.sort((a, b) => b.valuePaise - a.valuePaise).slice(0, 5) },
    negotiation: { count: negotiation.length, valuePaise: sum(negotiation, 'valuePaise') },
    unassignedLeads: rows.filter((r) => !r.ownerId).length,
    priority: [...rows].sort((a, b) => b.valuePaise * b.probability - a.valuePaise * a.probability || b.probability - a.probability).slice(0, 5),
    slowChats: slowChats.map((c) => ({ conversationId: c._id, customer: c.contactId?.name || '', waitingHours: Math.floor((now - new Date(c.lastInboundAt).getTime()) / HOUR), assignee: c.assigneeId ? names.get(String(c.assigneeId))?.name || '' : '' })),
    dues: { orders: dues.count, duePaise: dues.duePaise, over30Paise: dues.buckets['31-60'].duePaise + dues.buckets['60+'].duePaise },
    last90Days: { won, lost: closed90.length - won, winRatePct: pct(won, closed90.length), responseMedianSeconds: overview90.whatsapp.responseMedianSeconds, collectedPaise: overview90.payments.collectedPaise },
    generatedAt: new Date(),
  };
}

// --- CSV ------------------------------------------------------------------------------------
// Cells a spreadsheet would run as a formula (=, +, -, @) get a leading apostrophe.
function csvCell(value) {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const rupees = (paise) => ((paise || 0) / 100).toFixed(2);
const minutes = (seconds) => (seconds == null ? '' : (seconds / 60).toFixed(1));

async function exportCsv(req, query) {
  const { type } = query;
  let header;
  let lines;
  if (type === 'agents') {
    const data = await agents(req, query);
    header = ['Member', 'Chats handled', 'Messages sent', 'Replies', 'First response (median, min)', 'Response (median, min)', 'Response (average, min)', 'Leads created', ...LEAD_STAGES.map((s) => `Leads now at ${s}`), 'Won', 'Lost', 'Win rate %', 'Quotations sent', 'Quotations accepted', 'Orders', 'Order value (Rs)', 'Collected (Rs)', 'Tasks done', 'Tickets resolved'];
    lines = data.items.map((r) => [r.name, r.chatsHandled, r.messagesSent, r.replies, minutes(r.firstResponseMedianSeconds), minutes(r.responseMedianSeconds), minutes(r.responseAverageSeconds), r.leadsCreated, ...LEAD_STAGES.map((s) => r.leadsByStage[s]), r.won, r.lost, r.winRatePct, r.quotationsSent, r.quotationsAccepted, r.orders, rupees(r.orderValuePaise), rupees(r.collectedPaise), r.tasksDone, r.ticketsResolved]);
  } else if (type === 'sources') {
    const data = await sources(req, query);
    header = ['Source', 'Enquiries', 'Repeat enquiries', 'Rejected', 'Leads', 'Contacted or further', 'Quoted or further', 'Won', 'Lost', 'Conversion %'];
    lines = data.items.map((r) => [r.source, r.enquiries, r.repeatEnquiries, r.rejected, r.leads, r.funnel.contacted, r.funnel.quoted, r.funnel.won, r.byStage.Lost, r.conversionPct]);
  } else if (type === 'quotations') {
    const data = await quotations(req, query);
    header = ['Owner', 'Sent', 'Viewed', 'Accepted', 'Rejected', 'Expired', 'Still open', 'Win rate %', 'Value sent (Rs)', 'Value accepted (Rs)', 'Average days to accept'];
    lines = [...data.byOwner, { name: 'Total', ...data.totals }].map((r) => [r.name, r.sent, r.viewed, r.accepted, r.rejected, r.expired, r.open, r.winRatePct, rupees(r.sentValuePaise), rupees(r.acceptedValuePaise), r.averageDaysToAccept ?? '']);
  } else if (type === 'broadcasts') {
    const data = await broadcasts(req, query);
    header = ['Broadcast', 'Started', 'Template', 'Segment', 'Recipients', 'Sent', 'Delivered', 'Read', 'Replied', 'Failed', 'Skipped', 'Delivered %', 'Read %', 'Replied %'];
    lines = data.items.map((b) => [b.name, b.startedAt ? istDay(b.startedAt) : '', b.templateName, b.segmentName, b.total, b.sent, b.delivered, b.read, b.replied, b.failed, b.skipped, b.deliveredPct, b.readPct, b.repliedPct]);
  } else if (type === 'payments') {
    const data = await payments(req, query);
    header = ['Period', 'Payments', 'Collected (Rs)'];
    lines = [...data.trend.map((r) => [r.bucket, r.count, rupees(r.amountPaise)]), ['Total', data.collected.count, rupees(data.collected.amountPaise)], [], ['How paid', 'Payments', 'Collected (Rs)'], ...data.byWay.map((r) => [r.name, r.count, rupees(r.amountPaise)])];
  } else if (type === 'trend') {
    const data = await trend(req, query);
    header = ['Period', 'Leads created', 'Leads won', 'Orders', 'Order value (Rs)', 'Collected (Rs)'];
    lines = data.items.map((r) => [r.bucket, r.leads, r.won, r.orders, rupees(r.orderValuePaise), rupees(r.collectedPaise)]);
  } else {
    const o = await overview(req, query);
    header = ['Measure', 'Value'];
    lines = [
      ['Leads created', o.leads.created], ['Leads won', o.leads.won], ['Leads lost', o.leads.lost], ['Win rate %', o.leads.winRatePct],
      ['Quotations sent', o.quotations.sent], ['Quotations accepted', o.quotations.accepted],
      ['Orders', o.orders.count], ['Order value (Rs)', rupees(o.orders.valuePaise)], ['Collected (Rs)', rupees(o.payments.collectedPaise)],
      ['New customers', o.customers.new], ['Open leads now', o.pipeline.open], ['Open pipeline now (Rs)', rupees(o.pipeline.valuePaise)],
      ['Due now (Rs)', rupees(o.dues.duePaise)], ['New WhatsApp chats', o.whatsapp.newChats], ['First response, median (min)', minutes(o.whatsapp.firstResponseMedianSeconds)],
      ['Response, median (min)', minutes(o.whatsapp.responseMedianSeconds)], ['Tickets created', o.tickets.created], ['Tickets resolved', o.tickets.resolved],
    ];
  }
  const range = rangeOf(query);
  const csv = [[`${type || 'overview'} report`, `${range.from} to ${range.to}`], [], header, ...lines].map((cells) => cells.map(csvCell).join(',')).join('\r\n');
  // The BOM makes Excel read ₹ and Hindi names right.
  return { fileName: `report-${type || 'overview'}-${range.from}-to-${range.to}.csv`, csv: `﻿${csv}\r\n` };
}

module.exports = {
  overview, trend, agents, sources, quotations, broadcasts, payments, dashboard, insights, exportCsv, responseTurns, csvCell, seesAll,
};
