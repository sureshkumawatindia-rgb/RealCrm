jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Job = require('../models/Job');
const Lead = require('../models/Lead');
const LeadSourceConnection = require('../models/LeadSourceConnection');
const queue = require('../jobs/queue');
const indiamartService = require('../services/indiamartService');
const indiamart = require('../integrations/leadSources/indiamart');
const { api, bearer, login } = require('./helpers/api');

const KEY = 'MTc5MDY3NTQzMjY1MS1pbmRpYW1hcnQ';
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const lead = (id, extra = {}) => ({
  UNIQUE_QUERY_ID: id, QUERY_TYPE: 'W', QUERY_TIME: '2026-09-29 14:05:09', SENDER_NAME: 'Ravi Traders', SENDER_MOBILE: '+91-9829012345',
  SENDER_EMAIL: 'ravi@traders.in', SENDER_CITY: 'Jaipur', SENDER_STATE: 'Rajasthan', SENDER_COUNTRY_ISO: 'IN',
  QUERY_PRODUCT_NAME: 'Cumin Seeds', QUERY_MESSAGE: 'Need 50 kg\r\nevery month', ...extra,
});

describe('IndiaMART API details', () => {
  it('speaks IST in IndiaMART\'s formats and pulls overlapping windows of at most 7 days', () => {
    expect(indiamart.formatIst(new Date('2026-09-29T08:35:09Z'))).toBe('29-09-202614:05:09');
    expect(indiamart.parseQueryTime('2026-09-29 14:05:09').toISOString()).toBe('2026-09-29T08:35:09.000Z');
    const now = new Date('2026-09-29T10:00:00Z');
    expect(indiamart.pullWindow(null, now)).toEqual({ start: new Date('2026-09-28T10:00:00Z'), end: now, gap: false });
    expect(indiamart.pullWindow(new Date('2026-09-29T09:54:00Z'), now).start).toEqual(new Date('2026-09-29T09:49:00Z'));
    const late = indiamart.pullWindow(new Date('2026-09-10T00:00:00Z'), now);
    expect(late.gap).toBe(true);
    expect(now.getTime() - late.start.getTime()).toBeLessThan(7 * 24 * 60 * 60 * 1000);
  });

  it('turns an IndiaMART lead into an enquiry', () => {
    const phoneCall = indiamart.toIntake(lead('Q-9', { QUERY_TYPE: 'P', SENDER_NAME: 'IndiaMART Buyer', SENDER_COMPANY: 'Kiran Stores', CALL_DURATION: '45', QUERY_MESSAGE: '' }));
    expect(phoneCall).toMatchObject({
      type: 'P', sourceRef: 'Q-9', person: { name: 'Kiran Stores', phone: '+91-9829012345', city: 'Jaipur' },
      enquiry: { product: 'Cumin Seeds', message: 'Phone call (PNS), call duration 45' },
    });
    expect(indiamart.toIntake(lead('Q-10')).enquiry.message).toBe('Direct enquiry: Need 50 kg\nevery month');
  });
});

describe('IndiaMART connection', () => {
  let owner;
  let source;
  let calls;
  let reply;
  beforeAll(async () => {
    owner = await login('im-owner@example.com');
    indiamartService.register(queue);
  });
  beforeEach(() => {
    calls = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      calls.push(new URL(String(url)));
      return json(reply());
    });
  });
  afterEach(() => jest.restoreAllMocks());
  const rewind = (minutes) => LeadSourceConnection.updateOne({ _id: source.id }, { lastPolledAt: new Date(Date.now() - minutes * 60 * 1000) });

  it('keeps the key secret, gives a push URL, and schedules a pull a little over every 5 minutes', async () => {
    const res = await api().post('/api/v1/lead-sources').set(bearer(owner.token)).send({ type: 'indiamart', name: 'IndiaMART', apiKey: KEY });
    expect(res.status).toBe(201);
    source = res.body.data;
    expect(source).toMatchObject({ type: 'indiamart', source: 'IndiaMART', status: 'active', credentials: { configured: true, hint: KEY.slice(-4) }, settings: { queryTypes: ['W', 'B', 'P', 'WA'] } });
    expect(source.pushUrl).toMatch(/^http:\/\/127\.0\.0\.1:3000\/api\/v1\/webhooks\/leads\/indiamart\/[a-f0-9]{32}$/);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(JSON.stringify((await api().get('/api/v1/lead-sources').set(bearer(owner.token))).body)).not.toContain(KEY);
    const job = await Job.findOne({ uniqueKey: `indiamart:${source.id}` });
    expect(job).toMatchObject({ name: 'leadsource.indiamart.poll', repeatEveryMs: 5.5 * 60 * 1000, status: 'queued' });
  });

  it('the job pulls the last 24 hours first, takes the chosen kinds of leads, and remembers where it stopped', async () => {
    reply = () => ({ CODE: 200, STATUS: 'SUCCESS', TOTAL_RECORDS: 2, RESPONSE: [lead('IMQ-1'), lead('IMQ-2', { QUERY_TYPE: 'BIZ', SENDER_MOBILE: '+91-9811100011' })] });
    await queue.runDue();
    expect(calls).toHaveLength(1);
    const url = calls[0];
    expect(url.origin + url.pathname).toBe('https://mapi.indiamart.com/wservce/crm/crmListing/v2/');
    expect(url.searchParams.get('glusr_crm_key')).toBe(KEY);
    expect(url.searchParams.get('start_time')).toMatch(/^\d{2}-\d{2}-\d{4}\d{2}:\d{2}:\d{2}$/);
    const created = await Lead.findOne({ sourceRef: 'IMQ-1' });
    expect(created).toMatchObject({ source: 'IndiaMART', title: 'Cumin Seeds', stage: 'New' });
    expect(await Lead.exists({ sourceRef: 'IMQ-2' })).toBeNull(); // catalogue views are not taken by default
    const stored = await LeadSourceConnection.findById(source.id);
    expect(stored.cursor.lastEndTime).toBeTruthy();
    expect(stored.stats).toMatchObject({ received: 1, created: 1 });
  });

  it('never calls IndiaMART twice within 5 minutes; the next pull overlaps and takes nothing twice', async () => {
    reply = () => ({ CODE: 200, STATUS: 'SUCCESS', RESPONSE: [lead('IMQ-1'), lead('IMQ-3', { SENDER_MOBILE: '+91-9811100022', SENDER_NAME: 'Meena' })] });
    const tooSoon = await api().post(`/api/v1/lead-sources/${source.id}/pull`).set(bearer(owner.token));
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.message).toMatch(/Try again in [1-5] minute/);
    expect(calls).toHaveLength(0);

    const before = (await LeadSourceConnection.findById(source.id)).cursor.lastEndTime;
    await rewind(6);
    const pulled = await api().post(`/api/v1/lead-sources/${source.id}/pull`).set(bearer(owner.token));
    expect(pulled.body.data).toMatchObject({ called: true, fetched: 2, outcomes: { duplicate: 1, created: 1 } });
    const start = calls[0].searchParams.get('start_time');
    expect(start).toBe(indiamart.formatIst(new Date(before.getTime() - 5 * 60 * 1000)));
    expect(await Lead.countDocuments({ source: 'IndiaMART' })).toBe(2);
  });

  it('waits after IndiaMART\'s 429, and stops (until a new key) when the key is refused', async () => {
    const cursor = (await LeadSourceConnection.findById(source.id)).cursor.lastEndTime;
    reply = () => ({ CODE: 429, STATUS: 'FAILURE', MESSAGE: 'It is advised to hit this API once in every 5 minutes', TOTAL_RECORDS: 0, RESPONSE: [] });
    await rewind(6);
    await indiamartService.poll(source.id);
    let stored = await LeadSourceConnection.findById(source.id);
    expect(stored.lastError).toMatch(/wait 5 minutes/);
    expect(stored.cursor.lastEndTime).toEqual(cursor);

    reply = () => ({ CODE: 401, STATUS: 'FAILURE', MESSAGE: 'Pull API Key that you are using is incorrect.', RESPONSE: [] });
    await rewind(6);
    await indiamartService.poll(source.id);
    stored = await LeadSourceConnection.findById(source.id);
    expect(stored).toMatchObject({ status: 'error' });
    expect(stored.statusMessage).toMatch(/refused the API key/);
    expect(await Job.exists({ liveKey: `indiamart:${source.id}` })).toBeNull();

    const fixed = await api().patch(`/api/v1/lead-sources/${source.id}`).set(bearer(owner.token)).send({ apiKey: 'NEW-KEY-1234567890' });
    expect(fixed.body.data).toMatchObject({ status: 'active', statusMessage: '', credentials: { hint: '7890' } });
    expect(await Job.exists({ liveKey: `indiamart:${source.id}` })).toBeTruthy();
  });

  it('takes pushed leads once (also when the same lead is pulled), refuses unknown URLs, and drops leads while paused', async () => {
    const path = new URL(source.pushUrl).pathname;
    const push = (body) => api().post(path).set('Content-Type', 'application/json').send(JSON.stringify(body));
    const pushed = { CODE: 200, STATUS: 'SUCCESS', RESPONSE: lead('IMQ-7', { SENDER_MOBILE: '+91-9811100077', SENDER_NAME: 'Pushed Buyer' }) };
    expect((await push(pushed)).status).toBe(200);
    expect(await Lead.findOne({ sourceRef: 'IMQ-7' })).toMatchObject({ source: 'IndiaMART' });
    expect((await push(pushed)).status).toBe(200);
    expect(await Lead.countDocuments({ sourceRef: 'IMQ-7' })).toBe(1);

    reply = () => ({ CODE: 200, STATUS: 'SUCCESS', RESPONSE: [lead('IMQ-7', { SENDER_MOBILE: '+91-9811100077' })] });
    await rewind(6);
    expect((await indiamartService.poll(source.id)).outcomes).toEqual({ duplicate: 1 });

    expect((await api().post('/api/v1/webhooks/leads/indiamart/0123456789abcdef0123456789abcdef').set('Content-Type', 'application/json').send('{}')).status).toBe(404);
    expect((await api().post(path).set('Content-Type', 'application/json').send('{not json')).status).toBe(400);

    await api().patch(`/api/v1/lead-sources/${source.id}`).set(bearer(owner.token)).send({ status: 'paused' });
    expect(await Job.exists({ liveKey: `indiamart:${source.id}` })).toBeNull();
    expect((await push({ CODE: 200, RESPONSE: lead('IMQ-8', { SENDER_MOBILE: '+91-9811100088' }) })).status).toBe(200);
    expect(await Lead.exists({ sourceRef: 'IMQ-8' })).toBeNull();
  });

  it('is invisible to other companies', async () => {
    const stranger = await login('im-stranger@example.com');
    expect((await api().post(`/api/v1/lead-sources/${source.id}/pull`).set(bearer(stranger.token))).status).toBe(404);
    expect((await api().patch(`/api/v1/lead-sources/${source.id}`).set(bearer(stranger.token)).send({ apiKey: 'STOLEN-KEY-000000' })).status).toBe(404);
  });
});
