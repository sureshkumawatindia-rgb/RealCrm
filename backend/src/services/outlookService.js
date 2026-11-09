const mongoose = require('mongoose');
const CalendarEvent = require('../models/CalendarEvent');
const MicrosoftConnection = require('../models/MicrosoftConnection');
const microsoft = require('../integrations/microsoft');
const logger = require('../config/logger');
const httpError = require('../utils/httpError');
const microsoftService = require('./microsoftService');
const queue = require('../jobs/queue');

// The CRM calendar in Outlook (Phase 4B, D83), one way: a meeting's owner (its assignee, else who
// made it) sees it in their own Outlook calendar when they connected Microsoft 365, for meetings
// from the day they connected. Created, changed, moved to someone else and deleted in the CRM →
// the same in Outlook, through the job queue with retries. Only the event's `external.microsoft`
// (and `online.joinUrl`) fields are written here, straight to the collection, so a Microsoft
// failure never changes the CRM event itself (not even its updatedAt).
const JOB = 'microsoft.calendar-sync';
const DEBOUNCE_MS = 2000;
const IST_ZONE = 'India Standard Time';

const ownerOf = (event) => event.assigneeId || event.createdByMemberId || null;

// "10:30" + 30 minutes → "11:00" (same day; capped at 23:59).
function plusMinutes(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

// The Outlook event for a CRM event (Microsoft Graph's shape).
function outlookEventOf(event) {
  const timeZone = !event.timezone || event.timezone === 'Asia/Kolkata' ? IST_ZONE : event.timezone;
  const timed = Boolean(event.startTime);
  const lines = [event.description, event.relatedName && `About: ${event.relatedName}`, 'From AgreemCRM'].filter(Boolean);
  return {
    subject: event.title,
    body: { contentType: 'text', content: lines.join('\n') },
    isAllDay: !timed,
    start: { dateTime: `${event.date}T${timed ? event.startTime : '00:00'}:00`, timeZone },
    end: { dateTime: timed ? `${event.date}T${event.endTime || plusMinutes(event.startTime, 30)}:00` : `${nextDay(event.date)}T00:00:00`, timeZone },
    ...(event.online?.provider === 'teams' && { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' }),
  };
}

const setRemote = (eventId, fields) => CalendarEvent.collection.updateOne({ _id: eventId }, { $set: fields });
// Deleted events too (the plugin hides them from mongoose queries).
const loadAny = async (eventId) => {
  const raw = await CalendarEvent.collection.findOne({ _id: eventId });
  return raw ? CalendarEvent.hydrate(raw) : null;
};
const activeConnection = (organizationId, memberId) => (memberId ? MicrosoftConnection.findOne({ organizationId, memberId, status: 'active' }) : null);

// One pass: make Outlook match the CRM event. → 'synced' | 'removed' | 'skipped' | 'failed'.
async function syncOnce(eventId) {
  const provider = microsoft.provider();
  const event = await loadAny(eventId);
  if (!provider || !event) return 'skipped';
  const remote = event.external?.microsoft || {};
  const owner = ownerOf(event);
  const connection = event.deletedAt ? null : await activeConnection(event.organizationId, owner);
  const wanted = Boolean(connection) && (event.date >= (connection.calendarSyncFrom || '') || Boolean(remote.id));

  // It left a calendar: deleted, given to someone else, or its owner is no longer connected.
  let remoteId = remote.id || '';
  if (remoteId && (!wanted || String(remote.memberId) !== String(owner))) {
    const previous = await activeConnection(event.organizationId, remote.memberId);
    if (previous) await provider.deleteEvent(await microsoftService.accessTokenFor(previous), remoteId);
    await setRemote(event._id, { 'external.microsoft': { state: wanted ? 'pending' : 'removed', syncedAt: new Date(), error: '' } });
    remoteId = '';
  }
  if (!wanted) return remote.id ? 'removed' : 'skipped';

  try {
    const token = await microsoftService.accessTokenFor(connection);
    const body = outlookEventOf(event);
    let result;
    if (remoteId) {
      try {
        result = await provider.updateEvent(token, remoteId, body);
      } catch (error) {
        if (error.statusCode !== 404) throw error;
        remoteId = ''; // deleted in Outlook by hand: one-way sync puts it back
      }
    }
    // Graph's transactionId guards against a second create when a job is retried.
    if (!remoteId) result = await provider.createEvent(token, { ...body, transactionId: `crm-${event._id}-${remote.syncedAt ? new Date(remote.syncedAt).getTime() : 0}` });
    await setRemote(event._id, {
      'external.microsoft': { id: result.id, memberId: owner, state: 'synced', syncedAt: new Date(), error: '' },
      ...(result.joinUrl && { 'online.joinUrl': result.joinUrl }),
    });
    await MicrosoftConnection.updateOne({ _id: connection._id }, { $set: { lastSyncAt: new Date(), lastError: '' } });
    return 'synced';
  } catch (error) {
    await setRemote(event._id, { 'external.microsoft.state': 'failed', 'external.microsoft.error': String(error.message).slice(0, 300), 'external.microsoft.syncedAt': new Date() });
    if (error.retry) throw error; // the queue tries again later
    return 'failed';
  }
}

const toId = (id) => (typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id);

// The job: one pass, and another if the event changed while it ran (a change made during a run
// finds the job still live and is not queued again).
async function syncEvent({ eventId }) {
  let result = 'skipped';
  for (let pass = 0; pass < 3; pass += 1) {
    const before = (await CalendarEvent.collection.findOne({ _id: toId(eventId) }, { projection: { updatedAt: 1 } }))?.updatedAt;
    result = await syncOnce(toId(eventId));
    const after = (await CalendarEvent.collection.findOne({ _id: toId(eventId) }, { projection: { updatedAt: 1 } }))?.updatedAt;
    if (String(before) === String(after)) break;
  }
  return result;
}

// After a CRM change: queue a sync when the owner (now or before) has Microsoft 365 connected.
async function queueSync(event) {
  if (!microsoft.provider()) return;
  try {
    const owners = [ownerOf(event), event.external?.microsoft?.memberId].filter(Boolean);
    if (!owners.length || !(await MicrosoftConnection.exists({ organizationId: event.organizationId, memberId: { $in: owners } }))) return;
    await queue.enqueue(JOB, { eventId: String(event._id || event.id) }, {
      uniqueKey: `${JOB}:${event._id || event.id}`, organizationId: event.organizationId, runAt: new Date(Date.now() + DEBOUNCE_MS), maxAttempts: 5,
    });
  } catch (error) {
    logger.error(`Outlook sync for event ${event._id || event.id} could not be queued: ${error.message}`);
  }
}

// POST /events/:id/teams-meeting — a Teams link for this meeting, now (not through the queue).
async function addTeamsMeeting(req, event) {
  const owner = ownerOf(event);
  const connection = await MicrosoftConnection.findOne({ organizationId: req.tenant.organizationId, memberId: owner });
  if (!connection) {
    const mine = String(owner) === String(req.member._id);
    throw httpError(409, 'MICROSOFT_NOT_CONNECTED', mine
      ? 'Connect Microsoft 365 first: Settings → My profile → Microsoft 365.'
      : `${event.assigneeName || 'The person this meeting belongs to'} has not connected Microsoft 365, so the meeting cannot get a Teams link from their calendar.`);
  }
  if (connection.status !== 'active') throw httpError(409, 'MICROSOFT_RECONNECT', 'Microsoft 365 needs to be connected again: Settings → My profile.');
  await CalendarEvent.updateOne({ _id: event._id }, { $set: { 'online.provider': 'teams' } });
  const state = await syncOnce(event._id);
  const after = await loadAny(event._id);
  if (state !== 'synced' || !after.online?.joinUrl) {
    throw httpError(502, 'MICROSOFT_FAILED', `Microsoft did not make the Teams meeting${after.external?.microsoft?.error ? `: ${after.external.microsoft.error}` : ''}. Try again in a minute.`);
  }
  return { joinUrl: after.online.joinUrl, outlook: after.external.microsoft.state };
}

function register(jobs) {
  jobs.define(JOB, (data) => syncEvent(data), { maxAttempts: 5 });
}

module.exports = { JOB, register, queueSync, syncEvent, syncOnce, addTeamsMeeting, outlookEventOf, ownerOf };
