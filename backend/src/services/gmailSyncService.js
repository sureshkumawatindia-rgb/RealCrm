const Contact = require('../models/Contact');
const EmailMessage = require('../models/EmailMessage');
const GmailConnection = require('../models/GmailConnection');
const Lead = require('../models/Lead');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const { OPEN_STAGES } = require('../constants/crm');
const googleService = require('./googleService');

// Gmail sync (Phase 9A, D90): read-only, per member. The first sync (or one after Google's
// history ran out) reads the last 30 days, up to 500 messages; later ones read only what was
// added since the saved historyId (Gmail's history.list; a 404 there means a full sync). A
// message is kept only when one of its addresses is a customer of the company: its headers and
// Gmail's snippet, linked to those customers and their open deals. A message already kept is
// skipped (unique per connection), so overlapping syncs never store it twice.
const WINDOW = 'newer_than:30d';
const MAX_FULL = 500;
const MAX_HISTORY_PAGES = 10;
const MIN_GAP_MS = 60 * 1000;
const ADDRESS = /[^\s<>,;"']+@[^\s<>,;"']+\.[^\s<>,;"']+/g;
const addressesIn = (header) => [...new Set(String(header || '').toLowerCase().match(ADDRESS) || [])];

// The ids of messages to look at, and the cursor to save after.
async function changes(provider, creds, connection) {
  if (connection.historyId) {
    try {
      const ids = [];
      let page;
      let cursor = connection.historyId;
      for (let n = 0; n < MAX_HISTORY_PAGES; n += 1) {
        const result = await provider.history(creds, { startHistoryId: connection.historyId, pageToken: page });
        ids.push(...result.messageIds);
        cursor = result.historyId;
        page = result.nextPageToken;
        if (!page) break;
      }
      return { ids: [...new Set(ids)], cursor, full: false };
    } catch (error) {
      if (error.code !== 'HISTORY_GONE') throw error;
      logger.info(`Gmail history ran out for connection ${connection._id}: syncing the last 30 days again`);
    }
  }
  const { historyId } = await provider.profile(creds);
  const ids = [];
  let page;
  while (ids.length < MAX_FULL) {
    const result = await provider.listMessages(creds, { q: WINDOW, pageToken: page, maxResults: 100 });
    ids.push(...result.messages.map((m) => m.id));
    page = result.nextPageToken;
    if (!page) break;
  }
  return { ids: ids.slice(0, MAX_FULL), cursor: historyId, full: true };
}

// One sync of one connection → { fetched, stored, skipped, duplicates, full }.
async function syncConnection(connection) {
  const organizationId = connection.organizationId;
  const own = connection.emailAddress.toLowerCase();
  const stats = { fetched: 0, stored: 0, skipped: 0, duplicates: 0, full: false };
  await googleService.withGoogle(connection, async (provider, creds) => {
    const { ids, cursor, full } = await changes(provider, creds, connection);
    stats.full = full;
    const known = new Set((await EmailMessage.find({ connectionId: connection._id, gmailMessageId: { $in: ids } }).select('gmailMessageId').lean()).map((m) => m.gmailMessageId));
    const touched = new Map(); // contactId → latest time
    for (const id of ids) {
      if (known.has(id)) {
        stats.duplicates += 1;
        continue;
      }
      const message = await provider.getMessage(creds, id);
      stats.fetched += 1;
      const from = addressesIn(message.headers.from)[0] || '';
      const to = addressesIn(message.headers.to);
      const cc = addressesIn(message.headers.cc);
      const others = [...new Set([from, ...to, ...cc])].filter((a) => a && a !== own);
      const contacts = others.length ? await Contact.find({ organizationId, email: { $in: others } }).select('_id').lean() : [];
      if (!contacts.length) {
        stats.skipped += 1; // not with a customer: never kept
        continue;
      }
      const contactIds = contacts.map((c) => c._id);
      const leads = await Lead.find({ organizationId, contactId: { $in: contactIds }, stage: { $in: OPEN_STAGES } }).select('_id').lean();
      const sentAt = new Date(message.internalDate || Date.parse(message.headers.date) || Date.now());
      try {
        await EmailMessage.create({
          organizationId, connectionId: connection._id, userId: connection.userId, memberId: connection.memberId, gmailMessageId: id, threadId: message.threadId || '',
          direction: from === own ? 'out' : 'in', from, to, cc, subject: String(message.headers.subject || '').slice(0, 500), snippet: String(message.snippet || '').slice(0, 1000),
          sentAt, contactIds, leadIds: leads.map((l) => l._id), shared: connection.shareEmails !== false,
        });
        stats.stored += 1;
        for (const contactId of contactIds) {
          const key = String(contactId);
          if (!touched.has(key) || touched.get(key) < sentAt) touched.set(key, sentAt);
        }
      } catch (error) {
        if (error.code !== 11000) throw error;
        stats.duplicates += 1; // another sync kept it a moment ago
      }
    }
    // The customers were in touch: "last contacted" and their open deals' last activity move.
    for (const [contactId, at] of touched) {
      await Contact.updateOne({ _id: contactId, organizationId, $or: [{ lastContactedAt: null }, { lastContactedAt: { $lt: at } }] }, { $set: { lastContactedAt: at } });
      await Lead.updateMany({ organizationId, contactId, stage: { $in: OPEN_STAGES }, $or: [{ lastActivityAt: null }, { lastActivityAt: { $lt: at } }] }, { $set: { lastActivityAt: at } });
    }
    await GmailConnection.updateOne({ _id: connection._id }, { $set: { historyId: cursor, lastSyncAt: new Date(), lastSyncCount: stats.stored, lastError: '' } });
  });
  return stats;
}

// POST /gmail/sync — now, at most once a minute.
async function syncNow(req) {
  const connection = await googleService.connectionOf(req);
  if (!connection) throw httpError(404, 'GMAIL_NOT_CONNECTED', 'Google is not connected.');
  if (connection.lastSyncAt && Date.now() - connection.lastSyncAt.getTime() < MIN_GAP_MS) {
    return { skipped: true, lastSyncAt: connection.lastSyncAt, lastSyncCount: connection.lastSyncCount };
  }
  const stats = await syncConnection(connection);
  return { ...stats, lastSyncAt: new Date() };
}

function serializeEmail(m, viewerUserId = null) {
  return {
    id: m._id, threadId: m.threadId, direction: m.direction, from: m.from, to: m.to, cc: m.cc, subject: m.subject, snippet: m.snippet, sentAt: m.sentAt,
    contactIds: m.contactIds, shared: m.shared, mine: viewerUserId ? String(m.userId) === String(viewerUserId) : undefined,
  };
}
// What a member may see: shared emails, and their own private ones.
const visibleTo = (req) => ({ organizationId: req.tenant.organizationId, $or: [{ shared: true }, { userId: req.user._id }] });

// GET /gmail/threads/:threadId — the kept messages of a thread the member may see.
async function thread(req, threadId) {
  const items = await EmailMessage.find({ ...visibleTo(req), threadId }).sort({ sentAt: 1 }).limit(100).lean();
  if (!items.length) throw httpError(404, 'NOT_FOUND', 'Thread not found');
  return items.map((m) => serializeEmail(m, req.user._id));
}

// The job: one connection's sync; a refused grant stops it (googleService.markReconnect).
async function runJob({ connectionId }) {
  const connection = await GmailConnection.findById(connectionId);
  if (!connection || connection.status === 'needs_reconnect') return;
  try {
    await syncConnection(connection);
  } catch (error) {
    if (error.reconnect) return;
    await GmailConnection.updateOne({ _id: connection._id }, { $set: { lastError: String(error.message).slice(0, 300) } });
    if (error.retry) throw error;
  }
}

function register(jobQueue) {
  jobQueue.define(googleService.SYNC_JOB, (data) => runJob(data), { maxAttempts: 3 });
}

module.exports = { syncConnection, syncNow, thread, visibleTo, serializeEmail, runJob, register, addressesIn };
