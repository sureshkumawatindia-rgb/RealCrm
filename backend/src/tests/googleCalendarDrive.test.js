jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const CalendarEvent = require('../models/CalendarEvent');
const Job = require('../models/Job');
const google = require('../integrations/google');
const queue = require('../jobs/queue');
const googleCalendar = require('../services/googleCalendarService');
const { indiaDate } = require('../utils/dates');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Google Calendar and Drive (Phase 9B, D90): CRM meetings in the owner's Google Calendar (one
// way, with the time zone, no copies on retries), and Google Docs and Sheets for customers.
const mock = google.mock;
const req = (token) => ({
  get: (path) => api().get(`/api/v1${path}`).set(bearer(token)),
  post: (path, body) => api().post(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, body) => api().patch(`/api/v1${path}`).set(bearer(token)).send(body),
  del: (path) => api().delete(`/api/v1${path}`).set(bearer(token)),
});
const memberId = async (token, email) => (await req(token).get('/members')).body.data.find((m) => m.email === email).id;
async function connectGoogle(user, features) {
  const started = await req(user.token).post('/gmail/connect', { features });
  const consent = new URL(started.body.data.authorizationUrl);
  const callback = new URL((await api().get(`${consent.pathname}${consent.search}`)).headers.location);
  await api().get(`${callback.pathname}${callback.search}`);
}
// Calendar syncs wait a moment (debounce): make them due and run them.
const runSyncs = async () => {
  await Job.updateMany({ name: googleCalendar.JOB, status: 'queued' }, { $set: { runAt: new Date() } });
  await queue.runDue();
};

beforeAll(() => googleCalendar.register(queue));
afterAll(() => queue.stop());
beforeEach(() => mock.reset());

describe('Google Calendar', () => {
  it('puts the owner\'s CRM meetings in their Google Calendar, follows changes, and never makes copies', async () => {
    const owner = await login('gc-owner@example.com', { name: 'Tanya' });
    await inviteAndJoin(owner.token, 'gc-agent@example.com', { role: 'agent', modules: ['calendar'] });
    const agentId = await memberId(owner.token, 'gc-agent@example.com');
    const ownerId = await memberId(owner.token, 'gc-owner@example.com');
    const o = req(owner.token);
    await connectGoogle(owner, ['calendar']);
    const tomorrow = indiaDate(1);

    const meeting = (await o.post('/events', { title: 'Site visit: Kothari', date: tomorrow, startTime: '11:00', endTime: '12:00', description: 'Measure the floor' })).body.data;
    await runSyncs();
    let events = mock.events('gc-owner@example.com');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: `crm${meeting.id}0`, summary: 'Site visit: Kothari',
      start: { dateTime: `${tomorrow}T11:00:00`, timeZone: 'Asia/Kolkata' }, end: { dateTime: `${tomorrow}T12:00:00`, timeZone: 'Asia/Kolkata' },
    });
    expect((await o.get(`/events/${meeting.id}`)).body.data.google).toEqual({ state: 'synced', error: '' });

    // A change: the same Google event. Given to someone without Google: out of the calendar.
    await o.patch(`/events/${meeting.id}`, { title: 'Site visit: Kothari Marbles' });
    await runSyncs();
    events = mock.events('gc-owner@example.com');
    expect(events.map((e) => [e.id, e.summary])).toEqual([[`crm${meeting.id}0`, 'Site visit: Kothari Marbles']]);
    await o.patch(`/events/${meeting.id}`, { assigneeId: agentId });
    await runSyncs();
    expect(mock.events('gc-owner@example.com')).toEqual([]);
    expect((await CalendarEvent.findById(meeting.id)).external.google.state).toBe('removed');
    // Back to the owner: a new Google event (the next id), then deleted with the meeting.
    await o.patch(`/events/${meeting.id}`, { assigneeId: ownerId });
    await runSyncs();
    expect(mock.events('gc-owner@example.com').map((e) => e.id)).toEqual([`crm${meeting.id}1`]);
    await o.del(`/events/${meeting.id}`);
    await runSyncs();
    expect(mock.events('gc-owner@example.com')).toEqual([]);

    // Google made the event but its answer was lost: the retry finds it, no copy.
    mock.loseNextInsertAnswer();
    const call = (await o.post('/events', { title: 'Call Shah Tiles', date: tomorrow, startTime: '15:30' })).body.data;
    await runSyncs(); // fails, the job will retry
    await runSyncs();
    events = mock.events('gc-owner@example.com');
    expect(events.map((e) => e.id)).toEqual([`crm${call.id}0`]);
    expect(events[0].end).toEqual({ dateTime: `${tomorrow}T16:00:00`, timeZone: 'Asia/Kolkata' });
    expect((await CalendarEvent.findById(call.id)).external.google.state).toBe('synced');

    // An all-day meeting goes as dates; one before the day of connecting stays out.
    await o.post('/events', { title: 'Expo day', date: tomorrow });
    await o.post('/events', { title: 'Old meeting', date: indiaDate(-3), startTime: '10:00' });
    await runSyncs();
    const expo = mock.events('gc-owner@example.com').find((e) => e.summary === 'Expo day');
    expect(expo.start).toEqual({ date: tomorrow });
    expect(mock.events('gc-owner@example.com').some((e) => e.summary === 'Old meeting')).toBe(false);
  });

  it('leaves out members who did not give Calendar', async () => {
    const owner = await login('gc-gmail-only@example.com');
    await connectGoogle(owner, []);
    const demo = (await req(owner.token).post('/events', { title: 'Demo', date: indiaDate(1), startTime: '10:00' })).body.data;
    expect(await Job.countDocuments({ name: googleCalendar.JOB, 'data.eventId': String(demo.id) })).toBe(0);
  });
});

describe('Google Drive', () => {
  it('makes a Google Doc or Sheet for a customer, and recognises pasted Google links', async () => {
    const owner = await login('gd-owner@example.com');
    const o = req(owner.token);
    const contact = (await o.post('/contacts', { name: 'Kothari Marbles' })).body.data;
    const body = { kind: 'doc', name: 'Kothari Marbles: notes', relatedType: 'Customer', relatedId: contact.id };
    await connectGoogle(owner, []);
    expect((await o.post('/google/drive/files', body)).body.code).toBe('GOOGLE_NO_DRIVE');
    await connectGoogle(owner, ['drive']);
    const doc = await o.post('/google/drive/files', body);
    expect(doc.status).toBe(201);
    expect(doc.body.data).toMatchObject({ name: 'Kothari Marbles: notes', relatedType: 'Customer', google: { kind: 'doc' } });
    expect(doc.body.data.linkUrl).toMatch(/^https:\/\/docs\.google\.com\/document\/d\/mock-file-/);
    expect(mock.files('gd-owner@example.com').map((f) => f.mimeType)).toEqual(['application/vnd.google-apps.document']);
    const sheet = (await o.post('/google/drive/files', { ...body, kind: 'sheet', name: 'Kothari: rates' })).body.data;
    expect(sheet.google.kind).toBe('sheet');

    const pasted = (await o.post('/documents', { name: 'Price list', linkUrl: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp_qRsT-uv/edit#gid=0', relatedType: 'Customer', relatedId: contact.id })).body.data;
    expect(pasted.google).toEqual({ fileId: '1AbCdEfGhIjKlMnOp_qRsT-uv', kind: 'sheet' });
    const plain = (await o.post('/documents', { name: 'Brochure', linkUrl: 'https://example.com/brochure.pdf' })).body.data;
    expect(plain.google).toBeNull();

    const viewer = await inviteAndJoin(owner.token, 'gd-viewer@example.com', { role: 'viewer', modules: ['documents', 'customers'] });
    expect((await req(viewer.token).post('/google/drive/files', body)).status).toBe(403);
  });
});
