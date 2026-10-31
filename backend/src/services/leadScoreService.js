const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Quotation = require('../models/Quotation');
const Order = require('../models/Order');
const logger = require('../config/logger');
const bus = require('../realtime/bus');
const { OPEN_STAGES } = require('../constants/crm');

// How warm an open lead is (G2, D106): 0–100 points from what the customer and the CRM already
// show, never from an AI vendor. 30 to start with, then:
//   stage      Contacted +5, Quote Sent +10, Negotiation +20
//   source     the company's own record: a source that wins clearly more than its average +12
//              (+6 a little more), clearly less −8 (each with at least 10 closed leads in a
//              year); without that record a source that shows intent (an ad, the website, a
//              walk-in) +5
//   replies    (WhatsApp, 30 days) the customer answers within an hour +20, the same day +10,
//              after 3 days or more −5; our message unanswered for 3 days −10; they wrote in the
//              last 3 days +10; nothing from them for 30 days and more −10
//   quotation  (the latest sent) accepted +25, opened 3 times or more +20, opened +12, not opened
//              after 3 days −10, rejected −15, expired −5
//   orders     (the customer's, not cancelled) 3 or more +20, one or two +12
//   our side   nothing done on the lead for 21 days −10; its follow-up a day late or more −5
// Hot from 70, warm from 40, cold below. Each reason is a code with its points and numbers, so the
// pages say it in the person's language. Worked out again a minute after a reply, a quotation's
// status, an order, a payment or a stage change (one job per customer), and every day by a sweep;
// a closed lead has no score.
const JOB = 'leads.score';
const SWEEP = 'leads.score.sweep';
const DEBOUNCE_MS = 60 * 1000;
const SWEEP_EVERY_MS = 30 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const SWEEP_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = 30 * DAY_MS;
const BASE = 30;
const BANDS = Object.freeze({ hot: 70, warm: 40 });
const STAGE_POINTS = Object.freeze({ New: 0, Contacted: 5, 'Quote Sent': 10, Negotiation: 20 });
const INTENT_SOURCES = new Set(['WhatsApp Ad', 'Website widget', 'Website', 'Manual', 'Google Ads']);
const SOURCE_MIN_CLOSED = 10;
const QUIET_KINDS = new Set(['broadcast', 'csat']); // mass and feedback messages expect no answer
const EVENTS = new Set(['lead.created', 'lead.stage_changed', 'message.received', 'quotation.status_changed', 'order.created', 'order.stage_changed', 'payment.received']);

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const bandOf = (points) => (points >= BANDS.hot ? 'hot' : points >= BANDS.warm ? 'warm' : 'cold');
const wholeDays = (ms) => Math.max(Math.floor(ms / DAY_MS), 0);
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// A customer's WhatsApp messages (oldest first, { d: in|out, at, k: automation kind, t: type }) →
// how long they took to answer us (the last 10 times), whether our last message waits for an
// answer, and when they last wrote.
function replySignals(messages) {
  const delays = [];
  let waitingSince = null;
  let lastIn = null;
  for (const message of messages) {
    if (message.d === 'out') {
      if (QUIET_KINDS.has(message.k) || message.t === 'reaction') continue;
      if (!waitingSince) waitingSince = message.at;
    } else {
      lastIn = message.at;
      if (waitingSince) {
        delays.push(message.at - waitingSince);
        waitingSince = null;
      }
    }
  }
  return { delays: delays.slice(-10), waitingSince, lastIn };
}

// The company's leads closed in the last year, by source: { rate, bySource: Map(source → { closed, won }) }.
async function sourceRecord(organizationId, now) {
  const rows = await Lead.aggregate([
    { $match: { organizationId: oid(organizationId), deletedAt: null, stage: { $in: ['Won', 'Lost'] }, stageChangedAt: { $gte: new Date(now - 365 * DAY_MS) } } },
    { $group: { _id: '$source', closed: { $sum: 1 }, won: { $sum: { $cond: [{ $eq: ['$stage', 'Won'] }, 1, 0] } } } },
  ]);
  const closed = rows.reduce((sum, r) => sum + r.closed, 0);
  const won = rows.reduce((sum, r) => sum + r.won, 0);
  return { rate: closed ? won / closed : 0, bySource: new Map(rows.map((r) => [r._id || '', { closed: r.closed, won: r.won }])) };
}

// One lead and what is known about it → { points, band, reasons }.
function scoreOf(lead, facts, now = new Date()) {
  const reasons = [];
  const add = (code, points, params = {}) => {
    if (points) reasons.push({ code, points, params });
  };
  add('stage', STAGE_POINTS[lead.stage] || 0, { stage: lead.stage });

  const source = lead.source || '';
  const record = facts.sources?.bySource.get(source);
  if (record && record.closed >= SOURCE_MIN_CLOSED && facts.sources.rate > 0) {
    const rate = record.won / record.closed;
    const ratio = rate / facts.sources.rate;
    const params = { source, pct: Math.round(rate * 100), averagePct: Math.round(facts.sources.rate * 100) };
    if (ratio >= 1.5) add('source_strong', 12, params);
    else if (ratio >= 1.15) add('source_good', 6, params);
    else if (ratio <= 0.6) add('source_weak', -8, params);
  } else if (INTENT_SOURCES.has(source)) {
    add('source_intent', 5, { source });
  }

  const replies = facts.replies || { delays: [], waitingSince: null, lastIn: null };
  if (replies.delays.length) {
    const typical = median(replies.delays);
    if (typical <= HOUR_MS) add('reply_fast', 20, { minutes: Math.max(Math.round(typical / 60000), 1) });
    else if (typical <= DAY_MS) add('reply_day', 10, { hours: Math.max(Math.round(typical / HOUR_MS), 1) });
    else if (typical > 3 * DAY_MS) add('reply_slow', -5, { days: wholeDays(typical) });
  }
  if (replies.waitingSince && now - replies.waitingSince > 3 * DAY_MS) add('no_reply', -10, { days: wholeDays(now - replies.waitingSince) });
  if (replies.lastIn && now - replies.lastIn <= 3 * DAY_MS) add('wrote_recently', 10, { days: wholeDays(now - replies.lastIn) });
  else if (!replies.lastIn && facts.lastInboundAt && now - facts.lastInboundAt > WINDOW_MS) add('quiet', -10, { days: wholeDays(now - facts.lastInboundAt) });

  const quote = facts.quotation;
  if (quote) {
    const views = quote.viewCount || 0;
    if (quote.status === 'Accepted') add('quote_accepted', 25, { number: quote.number });
    else if (quote.status === 'Rejected') add('quote_rejected', -15, { number: quote.number });
    else if (views >= 3) add('quote_viewed_often', 20, { count: views, number: quote.number });
    else if (views >= 1) add('quote_viewed', 12, { count: views, number: quote.number });
    else if (quote.status === 'Expired') add('quote_expired', -5, { number: quote.number });
    else if (now - quote.sentAt > 3 * DAY_MS) add('quote_unopened', -10, { days: wholeDays(now - quote.sentAt), number: quote.number });
  }

  const orders = facts.orders || 0;
  if (orders >= 3) add('repeat_buyer', 20, { count: orders });
  else if (orders >= 1) add('bought_before', 12, { count: orders });

  const lastActivity = lead.lastActivityAt || lead.createdAt;
  if (lastActivity && now - lastActivity > 21 * DAY_MS) add('stale', -10, { days: wholeDays(now - lastActivity) });
  if (lead.followUpAt && now - lead.followUpAt >= DAY_MS) add('follow_up_overdue', -5, { days: wholeDays(now - lead.followUpAt) });

  const points = Math.min(Math.max(BASE + reasons.reduce((sum, r) => sum + r.points, 0), 0), 100);
  reasons.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { points, band: bandOf(points), reasons };
}

// What is known about these leads' customers, in a few queries for the whole batch.
async function factsFor(organizationId, leads, now) {
  const contactIds = [...new Set(leads.map((l) => String(l.contactId)))].map(oid);
  const conversations = await Conversation.find({ organizationId, contactId: { $in: contactIds } }).select('_id contactId lastInboundAt').lean();
  const contactOfChat = new Map(conversations.map((c) => [String(c._id), String(c.contactId)]));
  const lastInbound = new Map();
  for (const c of conversations) {
    const key = String(c.contactId);
    if (c.lastInboundAt && (!lastInbound.has(key) || c.lastInboundAt > lastInbound.get(key))) lastInbound.set(key, c.lastInboundAt);
  }
  const [messageRows, quotations, orderRows, sources] = await Promise.all([
    conversations.length
      ? Message.aggregate([
        { $match: { organizationId: oid(organizationId), conversationId: { $in: conversations.map((c) => c._id) }, createdAt: { $gte: new Date(now - WINDOW_MS - DAY_MS) } } },
        // When it happened: the CRM's own time, except for history imported from the phone (D60).
        { $project: { conversationId: 1, d: '$direction', k: '$automation.kind', t: '$type', at: { $cond: [{ $eq: ['$origin', 'history'] }, { $ifNull: ['$providerTimestamp', '$createdAt'] }, '$createdAt'] } } },
      ])
      : [],
    Quotation.find({ organizationId, leadId: { $in: leads.map((l) => l._id) }, sentAt: { $ne: null }, status: { $ne: 'Draft' } })
      .select('leadId number status viewCount sentAt').sort({ sentAt: -1 }).lean(),
    Order.aggregate([
      { $match: { organizationId: oid(organizationId), contactId: { $in: contactIds }, stage: { $ne: 'Cancelled' }, deletedAt: null } },
      { $group: { _id: '$contactId', count: { $sum: 1 } } },
    ]),
    sourceRecord(organizationId, now),
  ]);
  const messagesOf = new Map();
  for (const row of messageRows) {
    if (now - row.at > WINDOW_MS) continue;
    const key = contactOfChat.get(String(row.conversationId));
    if (!messagesOf.has(key)) messagesOf.set(key, []);
    messagesOf.get(key).push(row);
  }
  for (const list of messagesOf.values()) list.sort((a, b) => a.at - b.at);
  const latestQuote = new Map();
  for (const q of quotations) if (!latestQuote.has(String(q.leadId))) latestQuote.set(String(q.leadId), q);
  const ordersOf = new Map(orderRows.map((r) => [String(r._id), r.count]));
  return (lead) => {
    const contact = String(lead.contactId);
    return {
      sources,
      replies: replySignals(messagesOf.get(contact) || []),
      lastInboundAt: lastInbound.get(contact) || null,
      quotation: latestQuote.get(String(lead._id)) || null,
      orders: ordersOf.get(contact) || 0,
    };
  };
}

// Scores one company's leads (open ones get a score, closed ones lose theirs). Written straight to
// the collection: a score is not a change of the lead (no new updatedAt or version).
async function scoreLeads(organizationId, leads, now = new Date()) {
  const open = leads.filter((l) => OPEN_STAGES.includes(l.stage));
  const closed = leads.filter((l) => !OPEN_STAGES.includes(l.stage) && l.score?.band);
  const writes = closed.map((l) => ({ updateOne: { filter: { _id: l._id }, update: { $unset: { score: 1 } } } }));
  if (open.length) {
    const factsOf = await factsFor(organizationId, open, now);
    for (const lead of open) {
      const score = scoreOf(lead, factsOf(lead), now);
      writes.push({ updateOne: { filter: { _id: lead._id }, update: { $set: { score: { ...score, at: now } } } } });
    }
  }
  if (writes.length) await Lead.collection.bulkWrite(writes, { ordered: false });
  return { scored: open.length, cleared: closed.length };
}

const LEAD_FIELDS = '_id organizationId contactId stage source lastActivityAt followUpAt createdAt score';

// The job: one customer's leads (or one lead), after something happened.
async function scoreDue({ organizationId, contactId, leadId }) {
  const filter = { organizationId, deletedAt: null, ...(contactId ? { contactId } : { _id: leadId }) };
  const leads = await Lead.find(filter).select(LEAD_FIELDS).lean();
  return scoreLeads(organizationId, leads);
}

// The sweep: open leads never scored, or scored more than a day ago (the oldest first).
async function sweep(now = new Date()) {
  const leads = await Lead.find({ stage: { $in: OPEN_STAGES }, deletedAt: null, $or: [{ 'score.at': null }, { 'score.at': { $lt: new Date(now - STALE_MS) } }] })
    .select(LEAD_FIELDS).sort({ 'score.at': 1 }).limit(SWEEP_LIMIT).lean();
  const byOrganization = new Map();
  for (const lead of leads) {
    const key = String(lead.organizationId);
    if (!byOrganization.has(key)) byOrganization.set(key, []);
    byOrganization.get(key).push(lead);
  }
  let scored = 0;
  for (const [organizationId, list] of byOrganization) {
    try {
      scored += (await scoreLeads(organizationId, list, now)).scored;
    } catch (error) {
      logger.error(`Lead scores for organization ${organizationId} failed: ${error.message}`);
    }
  }
  return { scored };
}

// After an event about a customer: their leads are scored again a minute later (one job however
// many messages come in that minute).
function scoreSoon(queue, organizationId, contactId) {
  return queue.enqueue(JOB, { organizationId: String(organizationId), contactId: String(contactId) }, {
    runAt: new Date(Date.now() + DEBOUNCE_MS), uniqueKey: `score:${organizationId}:${contactId}`, organizationId,
  });
}

let listening = null;
function register(queue) {
  queue.define(JOB, scoreDue, { maxAttempts: 3 });
  queue.define(SWEEP, () => sweep(), { maxAttempts: 1 });
  queue.every(SWEEP, SWEEP_EVERY_MS).catch((error) => logger.error(`Scheduling ${SWEEP} failed: ${error.message}`));
  if (listening) bus.off('automation:event', listening);
  listening = (event) => {
    if (!EVENTS.has(event.type) || !event.contactId) return;
    scoreSoon(queue, event.organizationId, event.contactId).catch((error) => logger.warn(`Lead score not queued: ${error.message}`));
  };
  bus.on('automation:event', listening);
}

module.exports = { JOB, SWEEP, BANDS, scoreOf, replySignals, scoreLeads, scoreDue, sweep, scoreSoon, register };
