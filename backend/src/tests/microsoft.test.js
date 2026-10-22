jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const MicrosoftConnection = require('../models/MicrosoftConnection');
const OAuthState = require('../models/OAuthState');
const CalendarEvent = require('../models/CalendarEvent');
const TeamsChannel = require('../models/TeamsChannel');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const queue = require('../jobs/queue');
const microsoft = require('../integrations/microsoft');
const outlook = require('../services/outlookService');
const teams = require('../services/teamsChannelService');
const safeWebhook = require('../utils/safeWebhook');
const { decrypt } = require('../utils/secretBox');
const { indiaDate } = require('../utils/dates');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 4B (D83): Microsoft 365 per member (the stand-in in tests), Outlook calendar one way, a
// Teams link on a meeting, and Teams channel notes.
const { mock } = microsoft;
const auth = (user) => bearer(user.token);
const pathOf = (location) => { const url = new URL(location); return `${url.pathname}${url.search}`; };

// Connect through the real routes: connect → the stand-in's consent page → the callback.
async function connectMicrosoft(user) {
  const { authorizationUrl } = (await api().post('/api/v1/integrations/microsoft/connect').set(auth(user))).body.data;
  const consent = await api().get(pathOf(authorizationUrl));
  expect(consent.status).toBe(302);
  const back = await api().get(pathOf(consent.headers.location));
  expect(back.status).toBe(302);
  return { authorizationUrl, consent: consent.headers.location, landing: back.headers.location };
}
const eventOf = (user, body) => api().post('/api/v1/events').set(auth(user)).send({ type: 'Meeting', date: indiaDate(1), startTime: '10:00', endTime: '10:45', ...body });
const sync = (id) => outlook.syncEvent({ eventId: String(id) });

describe('Microsoft 365, Outlook and Teams (Phase 4B)', () => {
  beforeEach(() => mock.reset());
  afterAll(() => {
    jest.restoreAllMocks();
    safeWebhook.setLookup((hostname) => require('dns').promises.lookup(hostname, { all: true, verbatim: true }));
  });

  it('signs a member in with PKCE and a single-use state, keeps only encrypted tokens and the least scopes', async () => {
    const owner = await login('ms-owner@example.com', { name: 'Ritu' });
    expect((await api().get('/api/v1/integrations/microsoft').set(auth(owner))).body.data).toEqual({ mode: 'mock', connection: null });
    const { authorizationUrl, consent, landing } = await connectMicrosoft(owner);
    expect(authorizationUrl).toContain('/api/v1/integrations/microsoft/mock-consent?state=');
    expect(new URL(landing).searchParams.get('microsoft')).toBe('connected');
    expect(new URL(landing).searchParams.get('tab')).toBe('profile');

    const saved = await MicrosoftConnection.findOne({ organizationId: owner.data.organizationId });
    expect(saved).toMatchObject({ email: 'mock.user@contoso.example', status: 'active', calendarSyncFrom: indiaDate(0) });
    expect([...saved.scopes]).toEqual(['openid', 'email', 'offline_access', 'User.Read', 'Calendars.ReadWrite']);
    expect(saved.encryptedAccessToken).not.toMatch(/mock-access/);
    expect(decrypt(saved.encryptedAccessToken)).toMatch(/^mock-access-/);
    const seen = (await api().get('/api/v1/integrations/microsoft').set(auth(owner))).body.data;
    expect(seen.connection).toMatchObject({ connected: true, email: 'mock.user@contoso.example', status: 'active' });
    expect(JSON.stringify(seen)).not.toMatch(/mock-access|mock-refresh|encrypted/i);

    // The same answer again: the state was used up.
    const replay = await api().get(pathOf(consent));
    expect(new URL(replay.headers.location).searchParams.get('reason')).toBe('invalid_or_expired_state');
    // A code made for another sign-in fails the PKCE check.
    const second = (await api().post('/api/v1/integrations/microsoft/connect').set(auth(owner))).body.data.authorizationUrl;
    const state = new URL(second).searchParams.get('state');
    const wrong = await api().get(`/api/v1/integrations/microsoft/callback?code=mock:someone-else&state=${state}`);
    expect(new URL(wrong.headers.location).searchParams.get('microsoft')).toBe('error');
    // An old state has expired.
    const third = new URL((await api().post('/api/v1/integrations/microsoft/connect').set(auth(owner))).body.data.authorizationUrl).searchParams.get('state');
    await OAuthState.updateOne({ state: third }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const late = await api().get(`/api/v1/integrations/microsoft/callback?code=mock:${third}&state=${third}`);
    expect(new URL(late.headers.location).searchParams.get('reason')).toBe('invalid_or_expired_state');
    // Gmail's callback never takes a Microsoft state.
    const fourth = new URL((await api().post('/api/v1/integrations/microsoft/connect').set(auth(owner))).body.data.authorizationUrl).searchParams.get('state');
    await api().get(`/api/v1/gmail/oauth/callback?code=x&state=${fourth}`);
    expect(await OAuthState.exists({ state: fourth })).toBeTruthy();

    // Disconnect deletes the tokens; both steps are audited.
    expect((await api().delete('/api/v1/integrations/microsoft').set(auth(owner))).body.data).toEqual({ disconnected: true });
    expect(await MicrosoftConnection.countDocuments({ organizationId: owner.data.organizationId })).toBe(0);
    expect(await AuditLog.countDocuments({ organizationId: owner.data.organizationId, action: { $in: ['microsoft.connected', 'microsoft.disconnected'] } })).toBe(2);
  });

  it('puts the owner\'s meetings in Outlook, keeps them in step, and never changes the CRM event on a failure', async () => {
    const owner = await login('ms-sync@example.com', { name: 'Sana' });
    const agent = await inviteAndJoin(owner.token, 'ms-sync-agent@example.com', { role: 'agent' });
    await connectMicrosoft(owner);

    // Before the day of connecting: not synced.
    const old = (await eventOf(owner, { title: 'Old meeting', date: indiaDate(-3) })).body.data;
    expect(await sync(old.id)).toBe('skipped');

    const made = (await eventOf(owner, { title: 'Visit Ravi Traders', description: 'Bring samples' })).body.data;
    expect(await mongoose.model('Job').countDocuments({ name: outlook.JOB, 'data.eventId': String(made.id) })).toBe(1);
    expect(await sync(made.id)).toBe('synced');
    await sync(made.id); // a repeated job makes no second event
    expect(mock.events()).toHaveLength(1);
    expect(mock.events()[0]).toMatchObject({ subject: 'Visit Ravi Traders', isAllDay: false, start: { dateTime: `${indiaDate(1)}T10:00:00`, timeZone: 'India Standard Time' }, end: { dateTime: `${indiaDate(1)}T10:45:00` } });
    expect(mock.events()[0].body.content).toContain('Bring samples');

    await api().patch(`/api/v1/events/${made.id}`).set(auth(owner)).send({ title: 'Visit Ravi Traders (moved)', startTime: '15:00', endTime: '' });
    await sync(made.id);
    expect(mock.events()).toHaveLength(1);
    expect(mock.events()[0]).toMatchObject({ subject: 'Visit Ravi Traders (moved)', end: { dateTime: `${indiaDate(1)}T15:30:00` } });
    expect((await api().get(`/api/v1/events/${made.id}`).set(auth(owner))).body.data.outlook).toEqual({ state: 'synced', error: '' });

    // Microsoft is down: the sync fails and is retried later; the CRM event stays as it was.
    const before = await CalendarEvent.findById(made.id).lean();
    await api().patch(`/api/v1/events/${made.id}`).set(auth(owner)).send({ description: 'Bring the price list' });
    const changed = await CalendarEvent.findById(made.id).lean();
    mock.failNext({ status: 503, retry: true });
    await expect(sync(made.id)).rejects.toMatchObject({ retry: true });
    const after = await CalendarEvent.findById(made.id).lean();
    expect([after.title, after.description, after.date, after.startTime, String(after.updatedAt)]).toEqual([changed.title, changed.description, changed.date, changed.startTime, String(changed.updatedAt)]);
    expect(after.external.microsoft.state).toBe('failed');
    expect(before.title).toBe(after.title);
    expect(await sync(made.id)).toBe('synced');

    // Given to someone without Microsoft 365: it leaves the owner's Outlook. Deleted: gone too.
    await api().patch(`/api/v1/events/${made.id}`).set(auth(owner)).send({ assigneeId: agent.data.member.id });
    expect(await sync(made.id)).toBe('removed');
    expect(mock.events()).toHaveLength(0);
    const second = (await eventOf(owner, { title: 'Call Meena' })).body.data;
    await sync(second.id);
    expect(mock.events()).toHaveLength(1);
    await api().delete(`/api/v1/events/${second.id}`).set(auth(owner));
    expect(await sync(second.id)).toBe('removed');
    expect(mock.events()).toHaveLength(0);
  });

  it('asks the member to connect again when Microsoft refuses the refresh, and changes nothing else', async () => {
    const owner = await login('ms-revoke@example.com', { name: 'Tara' });
    await connectMicrosoft(owner);
    const connection = await MicrosoftConnection.findOne({ organizationId: owner.data.organizationId });
    mock.revoke(decrypt(connection.encryptedRefreshToken));
    await MicrosoftConnection.updateOne({ _id: connection._id }, { $set: { tokenExpiry: new Date(Date.now() - 1000) } });
    const event = (await eventOf(owner, { title: 'Demo' })).body.data;
    expect(await sync(event.id)).toBe('failed'); // not retried: only the member can fix it
    expect((await MicrosoftConnection.findById(connection._id)).status).toBe('needs_reconnect');
    const notes = await Notification.find({ organizationId: owner.data.organizationId, source: 'microsoft' });
    expect(notes.map((n) => n.title)).toEqual(['Connect Microsoft 365 again']);
    expect((await CalendarEvent.findById(event.id)).title).toBe('Demo');
    const status = (await api().get('/api/v1/integrations/status').set(auth(owner))).body.data.items.find((i) => i.kind === 'microsoft');
    expect(status).toMatchObject({ state: 'attention', settingsTab: 'profile' });
  });

  it('adds a Teams link to a meeting in one call, from the owner\'s calendar', async () => {
    const owner = await login('ms-teams-link@example.com', { name: 'Uma' });
    const agent = await inviteAndJoin(owner.token, 'ms-teams-agent@example.com', { role: 'agent' });
    const event = (await eventOf(owner, { title: 'Quote review' })).body.data;
    expect((await api().post(`/api/v1/events/${event.id}/teams-meeting`).set(auth(owner))).body.code).toBe('MICROSOFT_NOT_CONNECTED');
    await connectMicrosoft(owner);
    const made = await api().post(`/api/v1/events/${event.id}/teams-meeting`).set(auth(owner));
    expect(made.status).toBe(200);
    expect(made.body.data.joinUrl).toMatch(/^https:\/\/teams\.microsoft\.com\/l\/meetup-join\/mock-/);
    expect((await api().get(`/api/v1/events/${event.id}`).set(auth(owner))).body.data.joinUrl).toBe(made.body.data.joinUrl);
    expect(mock.events()[0]).toMatchObject({ isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' });
    // A meeting of someone who did not connect: said plainly.
    const theirs = (await eventOf(owner, { title: 'Agent visit', assigneeId: agent.data.member.id })).body.data;
    const refused = await api().post(`/api/v1/events/${theirs.id}/teams-meeting`).set(auth(owner));
    expect(refused.body).toMatchObject({ code: 'MICROSOFT_NOT_CONNECTED' });
  });

  it('posts business events to a Teams channel, retries failures and switches off after three refusals', async () => {
    const owner = await login('teams-owner@example.com', { name: 'Vani' });
    const agent = await inviteAndJoin(owner.token, 'teams-agent@example.com', { role: 'agent' });
    safeWebhook.setLookup(async () => [{ address: '20.42.65.85', family: 4 }]);
    const posted = [];
    let answer = 202;
    jest.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      posted.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response('', { status: answer });
    });
    const url = 'https://prod-07.centralindia.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=SECRETSIGNATURE123';
    const add = (body) => api().post('/api/v1/integrations/teams-channels').set(auth(owner)).send(body);
    expect((await add({ name: 'Sales', url: 'https://hooks.example.com/teams', events: ['lead.won'] })).body.code).toBe('TEAMS_URL');
    expect((await add({ name: 'Sales', url: 'http://x.logic.azure.com/a', events: ['lead.won'] })).body.code).toBe('TEAMS_URL');
    expect((await api().post('/api/v1/integrations/teams-channels').set(auth(agent)).send({ name: 'Sales', url, events: ['lead.won'] })).status).toBe(403);
    const made = await add({ name: 'Sales wins', url, events: ['lead.won', 'ticket.created'] });
    expect(made.status).toBe(201);
    expect(made.body.data.urlHint).toBe('prod-07.centralindia.logic.azure.com …URE123');
    expect(JSON.stringify(made.body.data)).not.toContain('SECRETSIGNATURE');
    expect((await TeamsChannel.findById(made.body.data.id)).urlEnc).not.toContain('SECRETSIGNATURE');

    // A won lead and a new ticket post cards; a lead that is only contacted does not.
    teams.register(queue);
    const lead = (await api().post('/api/v1/leads').set(auth(owner)).send({ title: 'TMT bars', contact: { name: 'Gupta Steels', phone: '+919829080071' }, expectedValuePaise: 5000000 })).body.data;
    await api().post(`/api/v1/leads/${lead.id}/stage`).set(auth(owner)).send({ stage: 'Contacted' });
    await api().post(`/api/v1/leads/${lead.id}/stage`).set(auth(owner)).send({ stage: 'Won' });
    await api().post('/api/v1/tickets').set(auth(owner)).send({ subject: 'Bars bent on delivery', priority: 'High' });
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    const jobs = await mongoose.model('Job').find({ name: teams.JOB }).lean();
    expect(jobs.map((j) => j.data.type).sort()).toEqual(['lead.won', 'ticket.created']);
    for (const job of jobs) await teams.post(job.data);
    expect(posted).toHaveLength(2);
    const won = posted.find((p) => p.body.attachments[0].content.body[0].text.startsWith('🏆 Won'));
    expect(won.url).toBe(new URL(url).toString()); // the same address (the default :443 is dropped)
    expect(won.body.attachments[0]).toMatchObject({ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard' } });
    expect(won.body.attachments[0].content.body[1].facts).toEqual([{ title: 'Customer', value: 'Gupta Steels' }, { title: 'Value', value: '₹50,000' }, { title: 'Source', value: 'Manual' }]);
    expect(JSON.stringify(won.body)).not.toContain('+919829080071'); // no phone numbers in a channel

    // Teams is down: retried. Teams refuses three times: switched off, with the reason.
    const channelId = made.body.data.id;
    answer = 503;
    await expect(teams.post({ channelId, type: 'lead.won', event: { leadId: lead.id } })).rejects.toMatchObject({ retry: true });
    answer = 404;
    for (let i = 0; i < 3; i += 1) expect(await teams.post({ channelId, type: 'lead.won', event: { leadId: lead.id } })).toBe('refused');
    const off = await TeamsChannel.findById(channelId);
    expect(off).toMatchObject({ active: false, lastStatus: 'failed' });
    expect(off.disabledReason).toMatch(/Teams refused 3 cards in a row \(404\)/);
    expect(await teams.post({ channelId, type: 'lead.won', event: { leadId: lead.id } })).toBe('skipped');

    // Switched on again by hand, and the test card on the company's own click.
    answer = 200;
    await api().patch(`/api/v1/integrations/teams-channels/${channelId}`).set(auth(owner)).send({ active: true });
    expect((await api().post(`/api/v1/integrations/teams-channels/${channelId}/test`).set(auth(owner))).body.data).toEqual({ sent: true, status: 200 });
    const row = (await api().get('/api/v1/integrations/status').set(auth(owner))).body.data.items.find((i) => i.kind === 'teams');
    expect(row).toMatchObject({ name: 'Sales wins', state: 'working', settingsTab: 'integrations' });
    // Events that never post: a stage change that is not Won.
    expect(teams.teamsTypeOf({ type: 'lead.stage_changed', to: 'Lost' })).toBeNull();
    expect(teams.teamsTypeOf({ type: 'quotation.status_changed', to: 'Accepted' })).toBe('quotation.accepted');
  });
});
