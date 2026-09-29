jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const crypto = require('crypto');
const Job = require('../models/Job');
const Lead = require('../models/Lead');
const LeadIntake = require('../models/LeadIntake');
const LeadSourceConnection = require('../models/LeadSourceConnection');
const queue = require('../jobs/queue');
const leadWebhooks = require('../services/leadWebhookService');
const { api, bearer, login } = require('./helpers/api');

const PAGE_TOKEN = 'EAAPageToken0123456789abcdefghijklmnop';
const APP_SECRET = 'fb-app-secret-0123456789';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sign = (raw, secret = APP_SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
const pathOf = (url) => new URL(url).pathname;

describe('Facebook Lead Ads', () => {
  let owner;
  let fb;
  let calls;
  let leadReply;
  beforeAll(async () => {
    owner = await login('fb-owner@example.com');
    leadWebhooks.register(queue);
  });
  beforeEach(() => {
    calls = [];
    leadReply = () => json({
      id: 'LG-1', created_time: '2026-09-29T09:15:00+0000', form_id: 'F-9', ad_id: 'AD-1',
      field_data: [
        { name: 'full_name', values: ['Kiran Kumar'] }, { name: 'phone_number', values: ['+919812345678'] },
        { name: 'city', values: ['Jodhpur'] }, { name: 'which_product_do_you_need?', values: ['Red chilli, 200 kg'] },
      ],
    });
    jest.spyOn(global, 'fetch').mockImplementation(async (url, options = {}) => {
      const u = String(url);
      calls.push({ url: u, method: options.method || 'GET', auth: options.headers?.Authorization });
      if (u.includes('/subscribed_apps')) return json({ success: true });
      if (u.includes('/LG-')) return leadReply(u);
      if (u.includes('/F-9?')) return json({ id: 'F-9', name: 'Diwali Offer Form' });
      return json({ id: '1122334455', name: 'Yellow Traders' });
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('checks the token and subscribes the Page when connecting; secrets never come back', async () => {
    const res = await api().post('/api/v1/lead-sources').set(bearer(owner.token)).send({ type: 'facebook', pageId: '1122334455', pageAccessToken: PAGE_TOKEN, appSecret: APP_SECRET });
    expect(res.status).toBe(201);
    fb = res.body.data;
    expect(fb).toMatchObject({ type: 'facebook', source: 'Facebook', name: 'Facebook – Yellow Traders', settings: { pageId: '1122334455', pageName: 'Yellow Traders' } });
    expect(fb.verifyToken.length).toBeGreaterThan(20);
    expect(fb.pushUrl).toMatch(/\/api\/v1\/webhooks\/leads\/facebook\/[a-f0-9]{32}$/);
    expect(JSON.stringify(res.body)).not.toContain(PAGE_TOKEN);
    expect(JSON.stringify(res.body)).not.toContain(APP_SECRET);
    expect(calls.map((c) => [c.method, pathOf(c.url)])).toEqual([['GET', '/v26.0/1122334455'], ['POST', '/v26.0/1122334455/subscribed_apps']]);
    expect(calls[1].url).toContain('subscribed_fields=leadgen');
    expect(calls[0].auth).toBe(`Bearer ${PAGE_TOKEN}`);
  });

  it('refuses a Page the token cannot open, and saves nothing', async () => {
    jest.restoreAllMocks();
    jest.spyOn(global, 'fetch').mockImplementation(async () => json({ error: { message: 'Invalid OAuth access token.', code: 190 } }, 400));
    const refused = await api().post('/api/v1/lead-sources').set(bearer(owner.token)).send({ type: 'facebook', pageId: '54321', pageAccessToken: PAGE_TOKEN, appSecret: APP_SECRET });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe('Invalid OAuth access token.');
    expect(await LeadSourceConnection.countDocuments({ type: 'facebook' })).toBe(1);
  });

  it('answers Meta\'s handshake, takes only signed notifications, and fetches each lead once in a job', async () => {
    const path = pathOf(fb.pushUrl);
    const handshake = await api().get(`${path}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(fb.verifyToken)}&hub.challenge=424242`);
    expect(handshake.status).toBe(200);
    expect(handshake.text).toBe('424242');
    expect((await api().get(`${path}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`)).status).toBe(403);

    const note = (leadgenId, pageId = 1122334455) => JSON.stringify({
      object: 'page', entry: [{ id: pageId, time: 1790000000, changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: pageId, form_id: 'F-9', ad_id: 'AD-1', created_time: 1790000000 } }] }],
    });
    const post = (raw, signature = sign(raw)) => api().post(path).set('Content-Type', 'application/json').set('X-Hub-Signature-256', signature).send(raw);
    expect((await post(note('LG-1'), sign(note('LG-1'), 'wrong-secret-0000000'))).status).toBe(401);
    expect((await post(note('LG-1'))).status).toBe(200);
    expect((await post(note('LG-1'))).status).toBe(200); // Meta retries: one job
    expect((await post(note('LG-OTHER', 999)))).toBeTruthy(); // another Page: ignored
    expect(await Job.countDocuments({ name: leadWebhooks.FACEBOOK_FETCH })).toBe(1);

    await queue.runDue();
    const lead = await Lead.findOne({ source: 'Facebook', sourceRef: 'LG-1' });
    expect(lead).toMatchObject({ title: 'Diwali Offer Form', notes: 'which product do you need?: Red chilli, 200 kg' });
    const intake = await LeadIntake.findOne({ sourceRef: 'LG-1' });
    expect(intake.receivedAt.toISOString()).toBe('2026-09-29T09:15:00.000Z');
    expect(calls.find((c) => c.url.includes('/LG-1?')).url).toContain('fields=id,created_time,ad_id,form_id,field_data');

    await post(note('LG-1'));
    await queue.runDue();
    expect(await Lead.countDocuments({ sourceRef: 'LG-1' })).toBe(1);
  });

  it('stops asking Facebook when the token is refused, until a new token is pasted', async () => {
    leadReply = () => json({ error: { message: 'Error validating access token: Session has expired.', code: 190 } }, 400);
    await leadWebhooks.facebookFetch({ connectionId: fb.id, leadgenId: 'LG-2' });
    const stored = await LeadSourceConnection.findById(fb.id);
    expect(stored.status).toBe('error');
    expect(stored.statusMessage).toMatch(/Session has expired.*Paste a new Page access token/);

    const renewed = await api().patch(`/api/v1/lead-sources/${fb.id}`).set(bearer(owner.token)).send({ pageAccessToken: 'EAANewToken0123456789abcdefghijkl' });
    expect(renewed.body.data).toMatchObject({ status: 'active', statusMessage: '', credentials: { hint: 'ijkl' } });
  });
});

describe('Google Ads lead forms', () => {
  let owner;
  let google;
  const post = (body) => api().post(pathOf(google.pushUrl)).set('Content-Type', 'application/json').send(JSON.stringify(body));
  const payload = (extra = {}) => ({
    lead_id: 'GA-1', api_version: '1.0', form_id: 1234, campaign_id: 5678, google_key: google.googleKey, gcl_id: 'abc',
    user_column_data: [
      { column_id: 'FULL_NAME', column_name: 'Full Name', string_value: 'Meena Stores' },
      { column_id: 'PHONE_NUMBER', column_name: 'User Phone', string_value: '+91 98111 00044' },
      { column_id: 'CITY', column_name: 'City', string_value: 'Ajmer' },
      { column_id: 'SERVICE', column_name: 'What do you need?', string_value: 'Wholesale spices' },
    ],
    ...extra,
  });

  beforeAll(async () => {
    owner = await login('ga-owner@example.com');
    google = (await api().post('/api/v1/lead-sources').set(bearer(owner.token)).send({ type: 'googleads' })).body.data;
  });

  it('gives a URL and a key to paste into Google Ads, and only takes leads with that key', async () => {
    expect(google).toMatchObject({ type: 'googleads', source: 'Google Ads' });
    expect(google.googleKey.length).toBeGreaterThanOrEqual(20);
    const wrong = await post(payload({ google_key: 'guess' }));
    expect(wrong.status).toBe(400);
    expect(await Lead.exists({ source: 'Google Ads' })).toBeNull();

    const ok = await post(payload());
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({});
    expect(await Lead.findOne({ source: 'Google Ads', sourceRef: 'GA-1' })).toMatchObject({ notes: 'What do you need?: Wholesale spices' });
    expect((await post(payload())).status).toBe(200);
    expect(await Lead.countDocuments({ sourceRef: 'GA-1' })).toBe(1);
  });

  it('shows Google\'s test leads in the log without adding them to Leads', async () => {
    expect((await post(payload({ lead_id: 'GA-TEST', is_test: true }))).status).toBe(200);
    expect(await Lead.exists({ sourceRef: 'GA-TEST' })).toBeNull();
    const log = (await api().get(`/api/v1/lead-sources/${google.id}/intakes`).set(bearer(owner.token))).body.data;
    expect(log[0]).toMatchObject({ outcome: 'rejected', summary: 'Google Ads test data', reason: 'not added to Leads' });
  });
});

describe('JustDial and TradeIndia (any format)', () => {
  let owner;
  let jd;
  let ti;
  beforeAll(async () => {
    owner = await login('jd-owner@example.com');
    jd = (await api().post('/api/v1/lead-sources').set(bearer(owner.token)).send({ type: 'justdial' })).body.data;
    ti = (await api().post('/api/v1/lead-sources').set(bearer(owner.token)).send({ type: 'tradeindia' })).body.data;
  });

  it('reads leads sent as a query string, as form fields, or as a JSON list', async () => {
    const path = pathOf(jd.pushUrl);
    const get = await api().get(`${path}?leadid=JD-1&name=Sanjay%20Traders&mobile=9829011111&city=Jaipur&category=Cumin%20Seeds`);
    expect(get.status).toBe(200);
    expect(get.text).toBe('OK');
    expect(await Lead.findOne({ source: 'JustDial', sourceRef: 'JD-1' })).toMatchObject({ title: 'Cumin Seeds' });

    const form = await api().post(path).type('form').send({ CustomerName: 'Rekha', MobileNo: '98290 22222', Requirement: 'Need 10 kg turmeric' });
    expect(form.status).toBe(200);
    expect(await Lead.findOne({ source: 'JustDial', notes: 'Need 10 kg turmeric' })).toBeTruthy();
    // No id: the same content again (a retry) is taken once.
    await api().post(path).type('form').send({ CustomerName: 'Rekha', MobileNo: '98290 22222', Requirement: 'Need 10 kg turmeric' });
    expect(await LeadIntake.countDocuments({ source: 'JustDial', outcome: 'created' })).toBe(2);

    const list = await api().post(pathOf(ti.pushUrl)).set('Content-Type', 'application/json').send(JSON.stringify({
      data: [{ inquiry_id: 'TI-1', sender_name: 'Om Exports', sender_mobile: '+91-9811133333', product_name: 'Ajwain' }, { inquiry_id: 'TI-2', buyer_name: 'Lata', buyer_email: 'lata@example.com', subject: 'Fennel' }],
    }));
    expect(list.status).toBe(200);
    expect((await Lead.find({ source: 'TradeIndia' }).sort({ sourceRef: 1 })).map((l) => [l.sourceRef, l.title])).toEqual([['TI-1', 'Ajwain'], ['TI-2', 'Fennel']]);
  });

  it('keeps a format it cannot read in the log with the raw data, and refuses unknown addresses', async () => {
    const odd = await api().post(pathOf(jd.pushUrl)).set('Content-Type', 'application/json').send(JSON.stringify({ lead: { who: 'Someone', where: 'Kota' } }));
    expect(odd.status).toBe(200);
    const log = (await api().get(`/api/v1/lead-sources/${jd.id}/intakes`).set(bearer(owner.token))).body.data;
    expect(log[0]).toMatchObject({ outcome: 'rejected', reason: 'No valid mobile number or email', raw: { lead: { who: 'Someone', where: 'Kota' } } });
    expect((await api().get('/api/v1/webhooks/leads/justdial/0123456789abcdef0123456789abcdef?name=x&mobile=9829000000')).status).toBe(404);
    expect((await api().put(pathOf(jd.pushUrl)).send('x')).status).toBe(405);
  });
});
