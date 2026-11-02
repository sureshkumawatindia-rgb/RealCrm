const GmailConnection = require('../models/GmailConnection');
const Lead = require('../models/Lead');
const Order = require('../models/Order');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const SheetSync = require('../models/SheetSync');
const env = require('../config/env');
const logger = require('../config/logger');
const google = require('../integrations/google');
const queue = require('../jobs/queue');
const httpError = require('../utils/httpError');
const { audit } = require('../utils/audit');
const { businessHoursOf } = require('../utils/businessHours');
const googleService = require('./googleService');
const notificationService = require('./notificationService');

// Google Sheets (G4, D108): the company's new leads or new orders go to the end of a Google Sheet
// by themselves. An owner or admin switches it on with their own Google connection (Drive access:
// drive.file, so the CRM reaches only the sheets it made) and the CRM makes the sheet in their
// Drive, with a bold header row. A job every 2 minutes per sheet sends, in order, what was added
// since the last row it sent (the cursor: its time and id), up to 2,500 rows a run; with nothing
// new it does not call Google. It can start with the last 30 days. Private numbers' leads and
// orders stay out. It pauses, with a bell note to the owners and admins, when Google refuses the
// access, Drive access or the sheet is gone, or the person who switched it on is no longer an
// owner or admin (their Drive must not keep getting the company's data); Resume carries on in the
// same sheet. Values are written as plain values, never as formulas.
const JOB = 'sheets.sync';
const EVERY_MS = 2 * 60 * 1000;
const BATCH = 500;
const MAX_BATCHES = 5;
const SETTLE_MS = 5 * 1000; // records younger than this wait for the next run (a save may be going on)
const DAY_MS = 24 * 60 * 60 * 1000;
const KINDS = Object.freeze(['leads', 'orders']);
const MANAGERS = ['owner', 'admin'];
const SETTINGS_TAB = 'Settings.html?tab=integrations';
const jobKey = (sync) => `sheet-sync:${sync._id}`;

const rupees = (paise) => (Number.isFinite(paise) ? Math.round(paise) / 100 : null);
const phoneOf = (contact) => contact?.phoneE164 || contact?.phone || '';
const itemsText = (items = []) => items.map((i) => `${i.name || 'Item'} × ${i.quantity}${i.unit ? ` ${i.unit}` : ''}`).join('; ').slice(0, 1000);

// Each kind: its tab, the columns (header, value) and how its records are read.
const SHEETS = {
  leads: {
    tab: 'Leads', noun: 'new leads', title: 'New leads', model: Lead, filter: { private: { $ne: true } },
    contact: 'name phone phoneE164 email company city private',
    columns: [
      ['Added on', (l, ctx) => ctx.time(l.createdAt)],
      ['Customer', (l) => l.contactId?.name || ''],
      ['Phone', (l) => phoneOf(l.contactId)],
      ['Email', (l) => l.contactId?.email || ''],
      ['Company', (l) => l.contactId?.company || ''],
      ['City', (l) => l.contactId?.city || ''],
      ['Lead', (l) => l.title || 'Enquiry'],
      ['Source', (l) => l.source || ''],
      ['Campaign', (l) => l.attribution?.first?.campaign || ''],
      ['Stage', (l) => l.stage || ''],
      ['Value (₹)', (l) => rupees(l.expectedValuePaise)],
      ['Owner', (l, ctx) => ctx.owner(l.ownerId)],
      ['Open in CRM', (l) => `${env.frontendUrl}/leads.html?open=${l._id}`],
    ],
  },
  orders: {
    tab: 'Orders', noun: 'new orders', title: 'New orders', model: Order, filter: {},
    contact: 'name phone phoneE164 private',
    columns: [
      ['Date', (o, ctx) => ctx.time(o.orderDate || o.createdAt)],
      ['Order', (o) => o.number || ''],
      ['Customer', (o) => o.contactId?.name || o.billTo?.name || ''],
      ['Phone', (o) => phoneOf(o.contactId)],
      ['Items', (o) => itemsText(o.items)],
      ['Total (₹)', (o) => rupees(o.totals?.grandTotalPaise)],
      ['Paid (₹)', (o) => rupees(o.amountPaidPaise || 0)],
      ['Stage', (o) => o.stage || ''],
      ['From', (o) => (o.source === 'catalog' ? 'WhatsApp catalog' : o.quotationNumber ? `Quotation ${o.quotationNumber}` : '')],
      ['Owner', (o, ctx) => ctx.owner(o.ownerId)],
      ['Open in CRM', (o) => `${env.frontendUrl}/Orders.html?id=${o._id}`],
    ],
  },
};
const HEADERS = Object.freeze(Object.fromEntries(KINDS.map((kind) => [kind, SHEETS[kind].columns.map(([header]) => header)])));

// The records after a cursor (its time, then its id for records saved in the same millisecond).
const after = (cursorAt, cursorId) => (cursorId
  ? { $or: [{ createdAt: { $gt: cursorAt } }, { createdAt: cursorAt, _id: { $gt: cursorId } }] }
  : { createdAt: { $gt: cursorAt } });

async function namesOf(organizationId) {
  const members = await OrganizationMember.find({ organizationId }).populate('userId', 'name email').lean();
  return new Map(members.map((m) => [String(m._id), m.displayName || m.userId?.name || m.userId?.email || '']));
}

// Owners' names and the company's time ("2026-10-31 21:45" in its time zone) for the rows.
async function contextOf(organizationId) {
  const [organization, names] = await Promise.all([Organization.findById(organizationId).select('businessHours').lean(), namesOf(organizationId)]);
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: businessHoursOf(organization).timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return {
    owner: (id) => (id ? names.get(String(id)) || '' : ''),
    time: (date) => (date ? format.format(new Date(date)).replace(',', '') : ''),
  };
}

function publicSync(sync, names, req) {
  return {
    kind: sync.kind,
    url: sync.url,
    title: sync.title,
    status: sync.status,
    pausedReason: sync.pausedReason || '',
    rowsAdded: sync.rowsAdded || 0,
    lastRowAt: sync.lastRowAt || null,
    lastRunAt: sync.lastRunAt || null,
    lastError: sync.lastError || '',
    startedBy: { memberId: sync.memberId, name: names.get(String(sync.memberId)) || '', googleEmail: sync.googleEmail || '' },
    mine: Boolean(req && String(sync.userId) === String(req.user._id)),
    startedAt: sync.createdAt,
  };
}

const schedule = (sync, firstRunAt) => queue.every(JOB, EVERY_MS, { syncId: String(sync._id) }, { uniqueKey: jobKey(sync), organizationId: sync.organizationId, firstRunAt });

// --- owners and admins (Settings → Integrations → Google Sheets) -----------------------------
// GET /sheet-syncs: both sheets and the asking person's own Google connection.
async function list(req) {
  const organizationId = req.tenant.organizationId;
  const [syncs, connection, names] = await Promise.all([SheetSync.find({ organizationId }).lean(), googleService.connectionOf(req), namesOf(organizationId)]);
  const sheets = Object.fromEntries(KINDS.map((kind) => [kind, null]));
  for (const sync of syncs) sheets[sync.kind] = publicSync(sync, names, req);
  return {
    google: {
      available: google.mode() !== 'off',
      connected: Boolean(connection),
      drive: Boolean(connection?.features?.drive),
      email: connection?.emailAddress || '',
      needsReconnect: connection?.status === 'needs_reconnect',
    },
    sheets,
    headers: HEADERS,
  };
}

// POST /sheet-syncs { kind, backfillDays (0 or 30) }: makes the sheet in the asking person's Drive.
async function start(req, { kind, backfillDays = 0 }) {
  const organizationId = req.tenant.organizationId;
  const connection = await googleService.connectionOf(req);
  if (!connection?.features?.drive) throw httpError(409, 'GOOGLE_NO_DRIVE', 'Connect Google with Drive first: Settings → My profile → Google.');
  if (await SheetSync.exists({ organizationId, kind })) throw httpError(409, 'SHEET_SYNC_EXISTS', 'This sheet is on already.');
  const spec = SHEETS[kind];
  const organization = await Organization.findById(organizationId).select('name').lean();
  const title = `${spec.title} – ${organization?.name || 'CRM'}`;
  const sheet = await googleService.withGoogle(connection, (provider, creds) => provider.createSpreadsheet(creds, { title, sheetTitle: spec.tab, headers: HEADERS[kind] }));
  const now = new Date();
  let sync;
  try {
    sync = await SheetSync.create({
      organizationId, kind, userId: req.user._id, memberId: req.member._id, googleEmail: connection.emailAddress || '',
      spreadsheetId: sheet.id, sheetId: sheet.sheetId, url: sheet.url, title,
      cursorAt: backfillDays ? new Date(now.getTime() - backfillDays * DAY_MS) : now,
    });
  } catch (error) {
    if (error.code === 11000) throw httpError(409, 'SHEET_SYNC_EXISTS', 'This sheet is on already.'); // two clicks at once
    throw error;
  }
  await schedule(sync, backfillDays ? now : new Date(now.getTime() + EVERY_MS));
  await audit(req, { action: 'sheet_sync.started', entityType: 'SheetSync', entityId: sync._id, changes: { kind, url: sync.url, backfillDays } });
  return publicSync(sync.toObject(), await namesOf(organizationId), req);
}

// POST /sheet-syncs/:kind/resume: carries on in the same sheet once what paused it is fixed.
async function resume(req, kind) {
  const organizationId = req.tenant.organizationId;
  const paused = await SheetSync.findOne({ organizationId, kind, status: 'paused' }).lean();
  if (!paused) throw httpError(404, 'NOT_FOUND', 'There is no paused sheet to resume.');
  const member = await OrganizationMember.exists({ _id: paused.memberId, organizationId, status: 'active', role: { $in: MANAGERS } });
  if (!member) throw httpError(409, 'MEMBER_GONE', 'The person who switched it on is no longer an owner or admin. Stop it and switch it on again.');
  const connection = await GmailConnection.findOne({ userId: paused.userId, organizationId }).select('features status').lean();
  if (!connection?.features?.drive) throw httpError(409, 'GOOGLE_NO_DRIVE', `${paused.googleEmail || 'The person who switched it on'} connects Google with Drive first (Settings → My profile).`);
  if (connection.status === 'needs_reconnect') throw httpError(409, 'GOOGLE_RECONNECT', `${paused.googleEmail || 'The person who switched it on'} connects Google again first (Settings → My profile).`);
  const sync = await SheetSync.findOneAndUpdate({ _id: paused._id, status: 'paused' }, { $set: { status: 'active', pausedReason: '', lastError: '' } }, { returnDocument: 'after' }).lean();
  if (!sync) throw httpError(404, 'NOT_FOUND', 'There is no paused sheet to resume.');
  await schedule(sync, new Date());
  await audit(req, { action: 'sheet_sync.resumed', entityType: 'SheetSync', entityId: sync._id, changes: { kind } });
  return publicSync(sync, await namesOf(organizationId), req);
}

// DELETE /sheet-syncs/:kind: nothing more goes to the sheet; the sheet stays in that Drive.
async function stop(req, kind) {
  const sync = await SheetSync.findOneAndDelete({ organizationId: req.tenant.organizationId, kind });
  if (!sync) throw httpError(404, 'NOT_FOUND', 'This sheet is not on.');
  await queue.cancel(jobKey(sync));
  await audit(req, { action: 'sheet_sync.stopped', entityType: 'SheetSync', entityId: sync._id, changes: { kind, url: sync.url, rowsAdded: sync.rowsAdded } });
  return { stopped: true };
}

// --- the job ----------------------------------------------------------------------------------
function pauseMessage(sync, reason) {
  const who = sync.googleEmail || 'the person who switched it on';
  const where = 'Settings → API & webhooks → Google Sheets';
  if (reason === 'MEMBER_GONE') return `The person who switched it on (${who}) is no longer an owner or admin here, so the company's ${SHEETS[sync.kind].noun} no longer go to their Google Drive. Stop it and switch it on again in ${where}.`;
  if (reason === 'GOOGLE_RECONNECT') return `Google stopped accepting the CRM's access for ${who}. Connect Google again in Settings → My profile, then press Resume in ${where}.`;
  if (reason === 'GOOGLE_NO_DRIVE') return `Google with Drive is no longer connected for ${who}. Connect Google with Drive in Settings → My profile, then press Resume in ${where}.`;
  return `The sheet "${sync.title}" or its first tab was deleted. Stop it and switch it on again in ${where} for a new sheet.`;
}

// Stops the job and tells the owners and admins (once).
async function pause(sync, reason) {
  const message = pauseMessage(sync, reason);
  const { modifiedCount } = await SheetSync.updateOne({ _id: sync._id, status: 'active' }, { $set: { status: 'paused', pausedReason: reason, lastError: message, lastRunAt: new Date() } });
  await queue.cancel(jobKey(sync));
  if (!modifiedCount) return { added: 0, paused: reason };
  try {
    const managers = await OrganizationMember.find({ organizationId: sync.organizationId, status: 'active', role: { $in: MANAGERS } }).select('_id').lean();
    await notificationService.notify(sync.organizationId, managers.map((m) => m._id), {
      title: `Google Sheets: ${SHEETS[sync.kind].noun} stopped going to the sheet`, body: message, link: SETTINGS_TAB, source: 'sheets',
    });
  } catch (error) {
    logger.error(`Sheet sync note for ${sync._id} failed: ${error.message}`);
  }
  return { added: 0, paused: reason };
}

// One run: up to 5 batches of 500 rows. The cursor moves after each batch Google took, so a later
// failure never sends those rows again; a failed call is tried again at the next run (or sooner).
async function runSync(syncId, now = new Date()) {
  const sync = await SheetSync.findById(syncId).lean();
  if (!sync || sync.status !== 'active') {
    await queue.cancel(`sheet-sync:${syncId}`);
    return { added: 0 };
  }
  const member = await OrganizationMember.exists({ _id: sync.memberId, organizationId: sync.organizationId, status: 'active', role: { $in: MANAGERS } });
  if (!member) return pause(sync, 'MEMBER_GONE');
  const connection = await GmailConnection.findOne({ userId: sync.userId, organizationId: sync.organizationId });
  if (!connection?.features?.drive) return pause(sync, 'GOOGLE_NO_DRIVE');
  if (connection.status === 'needs_reconnect') return pause(sync, 'GOOGLE_RECONNECT');

  const spec = SHEETS[sync.kind];
  const until = new Date(now.getTime() - SETTLE_MS);
  let { cursorAt, cursorId } = sync;
  let ctx = null;
  let added = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const records = await spec.model.find({ organizationId: sync.organizationId, ...spec.filter, $and: [after(cursorAt, cursorId), { createdAt: { $lte: until } }] })
      .sort({ createdAt: 1, _id: 1 }).limit(BATCH).populate('contactId', spec.contact).lean();
    if (!records.length) break;
    ctx = ctx || await contextOf(sync.organizationId);
    const rows = records.filter((record) => !record.contactId?.private).map((record) => spec.columns.map(([, value]) => value(record, ctx)));
    if (rows.length) {
      try {
        await googleService.withGoogle(connection, (provider, creds) => provider.appendRows(creds, { spreadsheetId: sync.spreadsheetId, sheetId: sync.sheetId, rows }));
      } catch (error) {
        if (error.code === 'GOOGLE_RECONNECT') return pause(sync, 'GOOGLE_RECONNECT');
        if (error.code === 'GOOGLE_SCOPE') return pause(sync, 'GOOGLE_NO_DRIVE');
        if (error.code === 'GOOGLE_NOT_FOUND') return pause(sync, 'SHEET_GONE');
        await SheetSync.updateOne({ _id: sync._id }, { $set: { lastError: error.message, lastRunAt: new Date() } });
        throw error;
      }
    }
    const last = records[records.length - 1];
    ({ createdAt: cursorAt, _id: cursorId } = last);
    added += rows.length;
    await SheetSync.updateOne({ _id: sync._id }, { $set: { cursorAt, cursorId, ...(rows.length && { lastRowAt: new Date() }) }, $inc: { rowsAdded: rows.length } });
    if (records.length < BATCH) break;
  }
  await SheetSync.updateOne({ _id: sync._id }, { $set: { lastRunAt: new Date(), lastError: '' } });
  return { added };
}

function register(q) {
  q.define(JOB, ({ syncId }) => runSync(syncId), { maxAttempts: 1 });
}

// Every active sheet has its job, even after a restored database lost it (jobs/index.js start).
async function ensureSchedules() {
  for (const sync of await SheetSync.find({ status: 'active' }).select('_id organizationId').lean()) await schedule(sync);
}

module.exports = { JOB, KINDS, HEADERS, list, start, resume, stop, runSync, register, ensureSchedules };
