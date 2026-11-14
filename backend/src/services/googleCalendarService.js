const mongoose = require('mongoose');
const CalendarEvent = require('../models/CalendarEvent');
const GmailConnection = require('../models/GmailConnection');
const google = require('../integrations/google');
const logger = require('../config/logger');
const queue = require('../jobs/queue');
const googleService = require('./googleService');

// The CRM calendar in Google Calendar (Phase 9B, D90), one way, like Outlook (D83): a meeting's
// owner (its assignee, else who made it) sees it in their primary Google Calendar when they
// connected Google with Calendar, for meetings from the day they connected. Created, changed,
// moved to someone else and deleted in the CRM → the same in Google, through the job queue with
// retries. A new Google event gets an id made from the CRM event, so a retried insert finds it
// there instead of making a second one. Only `external.google` is written on the CRM event,
// straight to the collection, so a Google failure never changes the event itself.
const JOB = 'google.calendar-sync';
const DEBOUNCE_MS = 2000;
const DEFAULT_ZONE = 'Asia/Kolkata';

const ownerOf = (event) => event.assigneeId || event.createdByMemberId || null;
function plusMinutes(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

// The Google event for a CRM event (Calendar API's shape). The time zone goes with the times, so
// Google shows them right wherever the person's calendar is set.
function googleEventOf(event) {
  const timeZone = event.timezone || DEFAULT_ZONE;
  const timed = Boolean(event.startTime);
  const lines = [event.description, event.relatedName && `About: ${event.relatedName}`, 'From agreem360'].filter(Boolean);
  return {
    summary: event.title,
    description: lines.join('\n'),
    start: timed ? { dateTime: `${event.date}T${event.startTime}:00`, timeZone } : { date: event.date },
    end: timed ? { dateTime: `${event.date}T${event.endTime || plusMinutes(event.startTime, 30)}:00`, timeZone } : { date: nextDay(event.date) },
    ...(event.location && { location: event.location }),
  };
}
// Google's event ids are base32hex (0-9, a-v): the CRM id is hex, plus a generation.
const googleIdOf = (event, generation) => `crm${event._id}${generation.toString(32)}`;

const setRemote = (eventId, fields) => CalendarEvent.collection.updateOne({ _id: eventId }, { $set: fields });
const loadAny = async (eventId) => {
  const raw = await CalendarEvent.collection.findOne({ _id: eventId });
  return raw ? CalendarEvent.hydrate(raw) : null;
};
const calendarConnection = (organizationId, memberId) => (memberId ? GmailConnection.findOne({ organizationId, memberId, status: 'active', 'features.calendar': true }) : null);

// One pass: make Google match the CRM event. → 'synced' | 'removed' | 'skipped' | 'failed'.
async function syncOnce(eventId) {
  const event = await loadAny(eventId);
  if (!google.provider() || !event) return 'skipped';
  const remote = event.external?.google || {};
  const owner = ownerOf(event);
  const connection = event.deletedAt ? null : await calendarConnection(event.organizationId, owner);
  const wanted = Boolean(connection) && (event.date >= (connection.calendarSyncFrom || '') || Boolean(remote.id));

  // It left a calendar: deleted, given to someone else, or its owner is no longer connected. The
  // next Google event gets the next generation's id.
  let generation = remote.generation || 0;
  let remoteId = remote.id || '';
  if (remoteId && (!wanted || String(remote.memberId) !== String(owner))) {
    const previous = await calendarConnection(event.organizationId, remote.memberId);
    if (previous) await googleService.withGoogle(previous, (provider, creds) => provider.deleteEvent(creds, remoteId));
    generation += 1;
    await setRemote(event._id, { 'external.google': { state: wanted ? 'pending' : 'removed', generation, syncedAt: new Date(), error: '' } });
    remoteId = '';
  }
  if (!wanted) return remote.id ? 'removed' : 'skipped';

  try {
    const body = googleEventOf(event);
    const result = await googleService.withGoogle(connection, async (provider, creds) => {
      if (remoteId) {
        try {
          return await provider.updateEvent(creds, remoteId, body);
        } catch (error) {
          if (error.code !== 'GOOGLE_NOT_FOUND') throw error;
          generation += 1; // deleted in Google by hand: one-way sync puts it back
        }
      }
      const id = googleIdOf(event, generation);
      try {
        return await provider.insertEvent(creds, { ...body, id });
      } catch (error) {
        if (error.code !== 'GOOGLE_DUPLICATE') throw error;
        return provider.updateEvent(creds, id, body); // a retried insert: it is there already
      }
    });
    await setRemote(event._id, { 'external.google': { id: result.id, memberId: owner, state: 'synced', generation, syncedAt: new Date(), error: '' } });
    await GmailConnection.updateOne({ _id: connection._id }, { $set: { lastError: '' } });
    return 'synced';
  } catch (error) {
    await setRemote(event._id, { 'external.google.state': 'failed', 'external.google.error': String(error.message).slice(0, 300), 'external.google.syncedAt': new Date() });
    if (error.retry) throw error; // the queue tries again later
    return 'failed';
  }
}

const toId = (id) => (typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id);

// The job: one pass, and another if the event changed while it ran.
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

// After a CRM change: queue a sync when the owner (now or before) has Google Calendar connected.
async function queueSync(event) {
  if (!google.provider()) return;
  try {
    const owners = [ownerOf(event), event.external?.google?.memberId].filter(Boolean);
    if (!owners.length || !(await GmailConnection.exists({ organizationId: event.organizationId, memberId: { $in: owners }, 'features.calendar': true }))) return;
    await queue.enqueue(JOB, { eventId: String(event._id || event.id) }, {
      uniqueKey: `${JOB}:${event._id || event.id}`, organizationId: event.organizationId, runAt: new Date(Date.now() + DEBOUNCE_MS), maxAttempts: 5,
    });
  } catch (error) {
    logger.error(`Google Calendar sync for event ${event._id || event.id} could not be queued: ${error.message}`);
  }
}

function register(jobs) {
  jobs.define(JOB, (data) => syncEvent(data), { maxAttempts: 5 });
}

module.exports = { JOB, register, queueSync, syncEvent, syncOnce, googleEventOf, googleIdOf, ownerOf };
