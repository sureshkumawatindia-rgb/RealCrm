jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Contact = require('../models/Contact');
const EmailMessage = require('../models/EmailMessage');
const GmailConnection = require('../models/GmailConnection');
const Job = require('../models/Job');
const Notification = require('../models/Notification');
const OAuthState = require('../models/OAuthState');
const google = require('../integrations/google');
const gmailSync = require('../services/gmailSyncService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Google Workspace (Phase 9A, D90): the sign-in through the stand-in, the Gmail sync (only
// customers' emails, full and incremental, no duplicates), sharing, a revoked grant, refresh.
const mock = google.mock;
const req = (token) => ({
  get: (path) => api().get(`/api/v1${path}`).set(bearer(token)),
  post: (path, body) => api().post(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, body) => api().patch(`/api/v1${path}`).set(bearer(token)).send(body),
  del: (path) => api().delete(`/api/v1${path}`).set(bearer(token)),
});

// Connect Google the way a browser would: consent page → callback → Settings.
async function connectGoogle(user, features = []) {
  const started = await req(user.token).post('/gmail/connect', { features, returnUrl: 'http://localhost:5500/crm/frontend/Settings.html' });
  expect(started.status).toBe(200);
  const consent = new URL(started.body.data.authorizationUrl);
  const toCallback = await api().get(`${consent.pathname}${consent.search}`);
  expect(toCallback.status).toBe(302);
  const callback = new URL(toCallback.headers.location);
  const back = await api().get(`${callback.pathname}${callback.search}`);
  expect(back.status).toBe(302);
  return { back: new URL(back.headers.location), callback };
}

beforeEach(() => mock.reset());

describe('Google sign-in', () => {
  it('connects with only the features asked for, through a single-use state', async () => {
    const owner = await login('g-owner@example.com', { name: 'Neha' });
    expect((await req(owner.token).get('/gmail/connection')).body.data).toMatchObject({ connected: false, mode: 'mock' });
    const { back, callback } = await connectGoogle(owner, ['calendar']);
    expect(back.searchParams.get('gmail')).toBe('connected');
    expect(back.pathname).toMatch(/Settings\.html$/);
    const status = (await req(owner.token).get('/gmail/connection')).body.data;
    expect(status).toMatchObject({ connected: true, emailAddress: 'g-owner@example.com', status: 'active', features: { gmail: true, calendar: true, drive: false }, shareEmails: true });
    expect(status.scopes).toEqual(['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events']);
    const stored = await GmailConnection.findOne({ emailAddress: 'g-owner@example.com' });
    expect(stored.encryptedAccessToken).not.toContain('mock-access');
    // The same callback again: the state was used.
    const replay = await api().get(`${callback.pathname}${callback.search}`);
    expect(new URL(replay.headers.location).searchParams.get('reason')).toBe('invalid_or_expired_state');
    // An expired state.
    const started = await req(owner.token).post('/gmail/connect', {});
    const state = new URL(started.body.data.authorizationUrl).searchParams.get('state');
    await OAuthState.updateOne({ state }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const late = await api().get(`/api/v1/gmail/oauth/callback?code=mock:${state}&state=${state}`);
    expect(new URL(late.headers.location).searchParams.get('reason')).toBe('invalid_or_expired_state');
    // A sync job is waiting for the connection.
    expect(await Job.countDocuments({ name: 'google.gmail-sync', liveKey: `gmail-sync:${stored._id}` })).toBe(1);
  });
});

describe('Gmail sync', () => {
  it('keeps only emails with customers, once, through full and incremental syncs', async () => {
    const owner = await login('g-sync@example.com', { name: 'Arun' });
    const o = req(owner.token);
    const lead = (await o.post('/leads', { title: 'Granite slabs', contact: { name: 'Kothari Marbles', email: 'buy@kothari.in', phone: '+919829080801' } })).body.data;
    await o.post('/contacts', { name: 'Shah Tiles', email: 'shah@tiles.in' });
    const DAY = 24 * 60 * 60 * 1000;
    mock.addMessage('g-sync@example.com', { from: 'Kothari <buy@kothari.in>', to: 'g-sync@example.com', subject: 'Rate for 20 slabs?', snippet: 'Please send the rate', at: Date.now() - 2 * DAY, threadId: 't-1' });
    mock.addMessage('g-sync@example.com', { from: 'g-sync@example.com', to: 'buy@kothari.in, shah@tiles.in', subject: 'Re: Rate for 20 slabs?', snippet: 'Rs 180 per sq ft', at: Date.now() - DAY, threadId: 't-1' });
    mock.addMessage('g-sync@example.com', { from: 'friend@gmail.com', to: 'g-sync@example.com', subject: 'Dinner?', snippet: 'Personal' });
    await connectGoogle(owner);

    const first = (await o.post('/gmail/sync', {})).body.data;
    expect(first).toMatchObject({ full: true, fetched: 3, stored: 2, skipped: 1, duplicates: 0 });
    expect(await EmailMessage.countDocuments({ subject: 'Dinner?' })).toBe(0);
    const reply = await EmailMessage.findOne({ subject: 'Re: Rate for 20 slabs?' });
    expect(reply).toMatchObject({ direction: 'out', from: 'g-sync@example.com', to: ['buy@kothari.in', 'shah@tiles.in'] });
    expect(reply.contactIds).toHaveLength(2);
    expect(reply.leadIds.map(String)).toEqual([lead.id]);
    expect((await Contact.findById(lead.contactId)).lastContactedAt).toBeTruthy();

    // A second sync within a minute is not run; the next one reads only what is new.
    expect((await o.post('/gmail/sync', {})).body.data.skipped).toBe(true);
    await GmailConnection.updateOne({ emailAddress: 'g-sync@example.com' }, { $set: { lastSyncAt: new Date(Date.now() - 2 * 60 * 1000) } });
    mock.addMessage('g-sync@example.com', { from: 'buy@kothari.in', to: 'g-sync@example.com', subject: 'OK, send 20', snippet: 'Confirmed', threadId: 't-1' });
    const second = (await o.post('/gmail/sync', {})).body.data;
    expect(second).toMatchObject({ full: false, fetched: 1, stored: 1 });

    // Google's history ran out: a full sync again, and nothing twice.
    mock.forgetHistory('g-sync@example.com');
    const connection = await GmailConnection.findOne({ emailAddress: 'g-sync@example.com' });
    const third = await gmailSync.syncConnection(connection);
    expect(third).toMatchObject({ full: true, stored: 0, duplicates: 3 });
    expect(await EmailMessage.countDocuments({ connectionId: connection._id })).toBe(3);

    // The history and the thread.
    const history = (await o.get(`/contacts/${lead.contactId}/timeline?kinds=talk`)).body.data.items.filter((i) => i.source === 'email');
    expect(history.map((i) => [i.name, i.direction])).toEqual([['OK, send 20', 'in'], ['Re: Rate for 20 slabs?', 'out'], ['Rate for 20 slabs?', 'in']]);
    expect((await o.get('/gmail/threads/t-1')).body.data).toHaveLength(3);
  });

  it('shows the team shared emails only, keeps companies apart, and stops on a revoked grant', async () => {
    const owner = await login('g-share@example.com', { name: 'Isha' });
    const agent = await inviteAndJoin(owner.token, 'g-share-agent@example.com', { role: 'agent', modules: ['customers'], permissions: ['customers:view_all'] });
    const o = req(owner.token);
    const contact = (await o.post('/contacts', { name: 'Desai Exports', email: 'ops@desai.in' })).body.data;
    mock.addMessage('g-share@example.com', { from: 'ops@desai.in', to: 'g-share@example.com', subject: 'Shipment', snippet: 'Container ready' });
    await connectGoogle(owner);
    await o.post('/gmail/sync', {});
    const seenBy = async (token) => (await req(token).get(`/contacts/${contact.id}/timeline?kinds=talk`)).body.data.items.filter((i) => i.source === 'email').length;
    expect(await seenBy(agent.token)).toBe(1);
    expect((await o.patch('/gmail/connection', { shareEmails: false })).body.data.shareEmails).toBe(false);
    expect(await seenBy(agent.token)).toBe(0);
    expect(await seenBy(owner.token)).toBe(1);
    expect((await req(agent.token).get(`/gmail/threads/${(await EmailMessage.findOne({ subject: 'Shipment' })).threadId}`)).status).toBe(404);

    // Another company with a customer at the same address sees nothing of it.
    const other = await login('g-other@example.com');
    const theirs = (await req(other.token).post('/contacts', { name: 'Desai (theirs)', email: 'ops@desai.in' })).body.data;
    expect((await req(other.token).get(`/contacts/${theirs.id}/timeline?kinds=talk`)).body.data.items).toEqual([]);

    // Google revokes the grant: the next sync stops, asks to reconnect, and the job ends.
    mock.revoke('g-share@example.com');
    const connection = await GmailConnection.findOne({ emailAddress: 'g-share@example.com' });
    await GmailConnection.updateOne({ _id: connection._id }, { $set: { tokenExpiry: new Date(Date.now() - 1000) } });
    await GmailConnection.updateOne({ _id: connection._id }, { $set: { lastSyncAt: new Date(Date.now() - 5 * 60 * 1000) } });
    const refused = await o.post('/gmail/sync', {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('GOOGLE_RECONNECT');
    expect((await o.get('/gmail/connection')).body.data.status).toBe('needs_reconnect');
    expect(await Notification.countDocuments({ title: 'Connect Google again' })).toBe(1);
    expect(await Job.countDocuments({ name: 'google.gmail-sync', liveKey: `gmail-sync:${connection._id}`, status: 'queued' })).toBe(0);
    // Connecting again brings it back; disconnecting keeps the synced emails.
    await connectGoogle(owner);
    expect((await o.get('/gmail/connection')).body.data.status).toBe('active');
    expect((await o.del('/gmail/connection')).body.data.disconnected).toBe(true);
    expect(await EmailMessage.countDocuments({ subject: 'Shipment' })).toBe(1);
    expect((await o.get('/gmail/connection')).body.data.connected).toBe(false);
  });

  it('refreshes an ending access token before calling Google', async () => {
    const owner = await login('g-refresh@example.com');
    await connectGoogle(owner);
    const connection = await GmailConnection.findOne({ emailAddress: 'g-refresh@example.com' });
    await GmailConnection.updateOne({ _id: connection._id }, { $set: { tokenExpiry: new Date(Date.now() + 30 * 1000) } });
    const before = connection.encryptedAccessToken;
    expect((await req(owner.token).get('/gmail/profile')).body.data.emailAddress).toBe('g-refresh@example.com');
    const after = await GmailConnection.findById(connection._id);
    expect(after.encryptedAccessToken).not.toBe(before);
    expect(after.tokenExpiry.getTime()).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
  });
});
