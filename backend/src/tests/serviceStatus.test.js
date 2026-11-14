jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const env = require('../config/env');
const AuditLog = require('../models/AuditLog');
const InboundEvent = require('../models/InboundEvent');
const Job = require('../models/Job');
const PaymentConnection = require('../models/PaymentConnection');
const PlatformSetting = require('../models/PlatformSetting');
const ServiceHealth = require('../models/ServiceHealth');
const ServiceIncident = require('../models/ServiceIncident');
const User = require('../models/User');
const queue = require('../jobs/queue');
const metaCloud = require('../integrations/whatsapp/metaCloud');
const payments = require('../integrations/payments/http');
const serviceStatus = require('../services/serviceStatusService');
const totp = require('../utils/totp');
const { api, bearer, login } = require('./helpers/api');

// Phase 9 of the 100 phases (D151; docs/RELIABILITY.md): is the CRM working? Calls to Meta and the
// gateways are counted; a check once a minute opens and closes incidents; the public page and the
// banners read them, and the platform admin page can post a notice.
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const minuteOf = (at) => new Date(Math.floor(at.getTime() / MIN) * MIN);
const calls = (service, ok, failed, at = new Date()) => ServiceHealth.updateOne({ service, minute: minuteOf(at) }, { $inc: { ok, failed } }, { upsert: true });
const open = () => ServiceIncident.find({ endedAt: null }).lean();
const check = (options = {}) => serviceStatus.evaluate({ ask: async () => false, ...options });
const until = async (test) => {
  for (let i = 0; i < 200; i += 1) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('It did not happen in time.');
};

beforeEach(async () => {
  await Promise.all([ServiceIncident.deleteMany({}), ServiceHealth.deleteMany({}), PlatformSetting.deleteMany({ key: 'statusHeartbeat' }), Job.deleteMany({})]);
  serviceStatus.forget();
});
afterAll(() => queue.stop());

describe('Counting calls and opening incidents', () => {
  it('counts Meta\'s and the gateways\' answers, without slowing the call down', async () => {
    const original = global.fetch;
    const answers = [
      new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }),
      new Response(JSON.stringify({ error: { message: 'Service unavailable', code: 2 } }), { status: 503 }),
      new Response(JSON.stringify({ error: { message: 'Not a WhatsApp number', code: 131026 } }), { status: 400 }),
      new Response(JSON.stringify({ id: 'x' }), { status: 200 }),
      new Response('{}', { status: 502 }),
    ];
    global.fetch = async () => answers.shift();
    try {
      const credentials = { phoneNumberId: '1', accessToken: 't' };
      await metaCloud.sendMessage(credentials, { to: '919829000001', type: 'text', text: { body: 'x' } });
      const trouble = await metaCloud.sendMessage(credentials, { to: '919829000001', type: 'text', text: { body: 'x' } }).catch((e) => e);
      expect(trouble).toMatchObject({ temporary: true, providerCode: 2 });
      // A refusal of one number says nothing about Meta, and will not pass by itself.
      const refused = await metaCloud.sendMessage(credentials, { to: '919829000001', type: 'text', text: { body: 'x' } }).catch((e) => e);
      expect(refused).toMatchObject({ temporary: false, providerCode: 131026 });
      await payments.call('Razorpay', 'https://api.razorpay.com/v1/x');
      await expect(payments.call('Cashfree', 'https://api.cashfree.com/pg/x')).rejects.toMatchObject({ statusCode: 502 });
      // Nobody answering at all.
      global.fetch = async () => { throw new Error('offline'); };
      const offline = await metaCloud.sendMessage(credentials, { to: '919829000001', type: 'text', text: { body: 'x' } }).catch((e) => e);
      expect(offline).toMatchObject({ temporary: true, code: 'WHATSAPP_UNREACHABLE' });
    } finally {
      global.fetch = original;
    }
    const total = async (service) => {
      const rows = await ServiceHealth.find({ service }).lean();
      return [rows.reduce((n, r) => n + r.ok, 0), rows.reduce((n, r) => n + r.failed, 0)];
    };
    await until(async () => (await total('whatsapp')).join() === '2,2' && (await total('razorpay')).join() === '1,0' && (await total('cashfree')).join() === '0,1');
    expect((await ServiceHealth.find({ service: 'whatsapp' }).lean()).find((r) => r.failed).lastError).toMatch(/no answer|answered 503/);
  });

  it('opens at 5 failures and half the calls, turns "down" at 90%, and closes when calls work again', async () => {
    await calls('whatsapp', 10, 4);
    await check();
    expect(await open()).toEqual([]);
    expect(await serviceStatus.isDown('whatsapp')).toBe(false);

    await calls('whatsapp', 0, 6);
    await check();
    expect(await open()).toEqual([expect.objectContaining({ service: 'whatsapp', source: 'auto', level: 'degraded' })]);
    expect(await serviceStatus.hasTrouble('whatsapp')).toBe(true);
    expect(await serviceStatus.isDown('whatsapp')).toBe(false);

    await calls('whatsapp', 0, 100);
    await check();
    expect((await open())[0].level).toBe('down');
    expect(await serviceStatus.isDown('whatsapp')).toBe(true);
    expect(await ServiceIncident.countDocuments({})).toBe(1);

    // Calls work again (and the failures are out of the 5 minutes looked at).
    const later = new Date(Date.now() + 8 * MIN);
    await calls('whatsapp', 2, 0, later);
    await check({ now: later });
    expect(await open()).toHaveLength(1);
    await calls('whatsapp', 2, 0, later);
    await check({ now: later });
    expect(await open()).toEqual([]);
    expect((await ServiceIncident.findOne({ service: 'whatsapp' }).lean()).endedAt).toEqual(later);
  });

  it('with nobody calling a service, asks it directly before saying it is back', async () => {
    await calls('razorpay', 0, 9);
    await check();
    expect(await open()).toEqual([expect.objectContaining({ service: 'razorpay', level: 'down' })]);
    const later = new Date(Date.now() + 8 * MIN);
    await check({ now: later });
    expect(await open()).toHaveLength(1);
    await serviceStatus.evaluate({ now: later, ask: async (service) => service === 'razorpay' });
    expect(await open()).toEqual([]);
  });

  it('a long gap in the heartbeat is a stretch the CRM was not running', async () => {
    const start = new Date(Date.now() - 2 * HOUR);
    await check({ now: start });
    await check({ now: new Date(start.getTime() + 3 * MIN) });
    expect(await ServiceIncident.countDocuments({})).toBe(0);
    const back = new Date(start.getTime() + 30 * MIN);
    await check({ now: back });
    const gap = await ServiceIncident.findOne({ service: 'crm' }).lean();
    expect(gap).toMatchObject({ level: 'down', source: 'auto', startedAt: new Date(start.getTime() + 3 * MIN), endedAt: back });
  });

  it('background work waiting too long is shown, and goes when it catches up', async () => {
    await Job.create({ name: 'anything', status: 'queued', runAt: new Date(Date.now() - 20 * MIN) });
    await check();
    expect(await open()).toEqual([expect.objectContaining({ service: 'jobs', level: 'degraded' })]);
    await Job.deleteMany({});
    await check();
    expect(await open()).toEqual([]);
  });
});

describe('The public status (no sign-in)', () => {
  it('says how each service is, 30 days of history, and nothing about any company', async () => {
    const now = new Date('2026-11-08T06:00:00Z');
    await ServiceIncident.create([
      { service: 'whatsapp', source: 'auto', level: 'down', startedAt: new Date(now - 5 * DAY), endedAt: new Date(now - 2 * DAY) },
      { service: 'cashfree', source: 'auto', level: 'degraded', startedAt: new Date(now - 2 * HOUR) },
      { service: 'notice', source: 'manual', level: 'info', title: { en: 'Maintenance tonight', hi: 'आज रात रखरखाव' }, body: { en: 'About 10 minutes.', hi: 'लगभग 10 मिनट।' }, startedAt: new Date(now - HOUR) },
    ]);
    const status = await serviceStatus.publicStatus(now);
    expect(status.status).toBe('degraded');
    expect(status.services.map((s) => s.key)).toEqual(['crm', 'jobs', 'whatsapp', 'razorpay', 'cashfree']);
    const whatsapp = status.services.find((s) => s.key === 'whatsapp');
    expect(whatsapp).toMatchObject({ status: 'ok', since: null, uptime: 90 });
    expect(whatsapp.days).toHaveLength(30);
    expect(whatsapp.days.filter((d) => d === 2)).toHaveLength(4); // three days touch four dates
    expect(whatsapp.days[29]).toBe(0);
    expect(status.services.find((s) => s.key === 'cashfree')).toMatchObject({ status: 'degraded', uptime: 100 });
    expect(status.services.find((s) => s.key === 'cashfree').days[29]).toBe(1);
    expect(status.days).toHaveLength(30);
    expect(status.days[29]).toBe('2026-11-08');
    expect(status.notices).toEqual([expect.objectContaining({ level: 'info', title: { en: 'Maintenance tonight', hi: 'आज रात रखरखाव' }, body: { en: 'About 10 minutes.', hi: 'लगभग 10 मिनट।' } })]);
    expect(status.incidents.map((i) => [i.service, i.minutes])).toEqual([['cashfree', 120], ['whatsapp', 3 * 24 * 60]]);
  });

  it('answers without a sign-in, to any site, and may be kept for a moment', async () => {
    const res = await api().get('/api/v1/status').set('Origin', 'https://status.example.org');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.services.every((s) => s.status === 'ok' && s.uptime === 100)).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/organizationId|memberId|email/);
    expect((await api().get('/status')).headers.location).toBe('/crm/frontend/status.html');
  });

  it('an information notice does not change "all working"', async () => {
    await ServiceIncident.create({ service: 'notice', source: 'manual', level: 'info', title: { en: 'New features', hi: 'नई सुविधाएँ' }, startedAt: new Date() });
    expect((await serviceStatus.publicStatus()).status).toBe('ok');
  });
});

describe('The banners inside the CRM', () => {
  const notices = async (who) => (await api().get('/api/v1/status/notices').set(bearer(who.token))).body.data;

  it('needs a sign-in, and tells a company only what touches it', async () => {
    expect((await api().get('/api/v1/status/notices')).status).toBe(401);
    const withChats = await login('banner-wa@example.com');
    await api().post('/api/v1/whatsapp/accounts').set(bearer(withChats.token)).send({ provider: 'mock' });
    const withGateway = await login('banner-pay@example.com');
    await PaymentConnection.collection.insertOne({ organizationId: new mongoose.Types.ObjectId(withGateway.data.organizationId), provider: 'razorpay' });
    expect(await notices(withChats)).toEqual([]);

    await ServiceIncident.create([
      { service: 'whatsapp', source: 'auto', level: 'down', startedAt: new Date() },
      { service: 'razorpay', source: 'auto', level: 'degraded', startedAt: new Date() },
      { service: 'cashfree', source: 'auto', level: 'degraded', startedAt: new Date() },
      { service: 'notice', source: 'manual', level: 'info', title: { en: 'Maintenance', hi: 'रखरखाव' }, startedAt: new Date() },
    ]);
    serviceStatus.forget();
    expect((await notices(withChats)).map((n) => n.service).sort()).toEqual(['notice', 'whatsapp']);
    expect((await notices(withGateway)).map((n) => n.service).sort()).toEqual(['notice', 'razorpay']);
  });
});

describe('The platform admin page', () => {
  const ADMIN = 'status-admin@example.com';
  let admin;
  let stranger;
  let secret;
  const saved = env.platformAdminEmails;
  const codeAt = () => totp.codeAt(totp.base32Decode(secret), Date.now());
  const get = (who, path) => api().get(`/api/v1/platform${path}`).set(bearer(who.token));
  const post = (who, path, body = {}) => api().post(`/api/v1/platform${path}`).set(bearer(who.token)).send(body);
  const NOTICE = { level: 'degraded', title: { en: 'Slow reports', hi: 'रिपोर्ट धीमी हैं' }, body: { en: 'We are on it.', hi: 'हम देख रहे हैं।' }, untilHours: 2 };

  beforeAll(async () => {
    env.platformAdminEmails = [ADMIN];
    admin = await login(ADMIN);
    stranger = await login('status-stranger@example.com');
    const setup = (await api().post('/api/v1/auth/totp/setup').set(bearer(admin.token))).body.data;
    secret = setup.secret;
    await api().post('/api/v1/auth/totp/enable').set(bearer(admin.token)).send({ code: codeAt() });
    await User.updateOne({ email: ADMIN }, { $unset: { 'totp.lastStep': 1 } });
    expect((await post(admin, '/unlock', { code: codeAt() })).status).toBe(200);
  });
  afterAll(() => { env.platformAdminEmails = saved; });

  it('posts a notice in both languages, ends it, and it ends by itself', async () => {
    expect((await post(stranger, '/notices', NOTICE)).status).toBe(404); // the page does not exist for others
    expect((await post(admin, '/notices', { ...NOTICE, title: { en: 'Only English' } })).status).toBe(400);
    const posted = await post(admin, '/notices', NOTICE);
    expect(posted.status).toBe(201);
    expect(posted.body.data).toMatchObject({ service: 'notice', source: 'manual', level: 'degraded', title: NOTICE.title, body: NOTICE.body });
    expect(await AuditLog.exists({ action: 'platform.notice_posted' })).toBeTruthy();
    expect((await api().get('/api/v1/status')).body.data).toMatchObject({ status: 'degraded', notices: [{ id: posted.body.data.id }] });
    // Its time is over.
    await check({ now: new Date(Date.now() + 3 * HOUR) });
    expect(await open()).toEqual([]);
    const ended = await ServiceIncident.findById(posted.body.data.id).lean();
    expect(ended.endedAt).toEqual(ended.until);

    const second = (await post(admin, '/notices', NOTICE)).body.data;
    expect((await post(admin, `/incidents/${second.id}/end`)).status).toBe(200);
    expect(await open()).toEqual([]);
    expect((await post(admin, `/incidents/${second.id}/end`)).status).toBe(404);
  });

  it('shows the calls, what is open, and what could not be processed — with numbers and emails taken out', async () => {
    await calls('whatsapp', 7, 2);
    await ServiceHealth.updateOne({ service: 'whatsapp' }, { $set: { lastError: 'answered 503' } });
    await ServiceIncident.create({ service: 'razorpay', source: 'auto', level: 'down', startedAt: new Date() });
    await InboundEvent.create({ provider: 'razorpay', eventId: 'e1', kind: 'payment', status: 'failed', error: 'No match for ramesh@shop.in at +91 98290 12345' });
    await Job.create({ name: 'quote.send', status: 'failed', attempts: 3, lastError: 'SMTP refused sita@shop.in', finishedAt: new Date(), runAt: new Date() });

    expect((await get(stranger, '/health')).status).toBe(404);
    const { data } = (await get(admin, '/health')).body;
    expect(data.services.find((s) => s.key === 'whatsapp')).toEqual({ key: 'whatsapp', status: 'ok', ok: 7, failed: 2, lastError: 'answered 503' });
    expect(data.services.find((s) => s.key === 'razorpay').status).toBe('down');
    expect(data.open.map((i) => i.service)).toEqual(['razorpay']);
    expect(data.inbound).toMatchObject({ total: 1, groups: [{ provider: 'razorpay', kind: 'payment', count: 1, error: 'No match for ••• at •••' }] });
    expect(data.jobs).toMatchObject({ total: 1, groups: [{ name: 'quote.send', count: 1, error: 'SMTP refused •••' }], latest: [{ name: 'quote.send', error: 'SMTP refused •••' }] });
    await InboundEvent.deleteMany({});
  });

  it('tries again what could not be processed, and a job that gave up', async () => {
    await InboundEvent.deleteMany({});
    const events = await InboundEvent.create([
      { provider: 'razorpay', eventId: 'r1', kind: 'payment', status: 'failed', error: 'x' },
      { provider: 'razorpay-billing', eventId: 'r2', kind: 'payment', status: 'failed', error: 'x' },
    ]);
    const retried = await post(admin, '/health/inbound/retry');
    expect(retried.body.data).toEqual({ retried: 2 });
    expect((await InboundEvent.find({}).lean()).map((e) => [e.status, e.error])).toEqual([['received', ''], ['received', '']]);
    const waiting = await Job.find({ name: { $in: ['payment.webhook', 'billing.webhook'] } }).lean();
    expect(waiting.map((j) => [j.name, j.data.eventId]).sort()).toEqual([['billing.webhook', String(events[1]._id)], ['payment.webhook', String(events[0]._id)]]);

    const gaveUp = await Job.create({ name: 'quote.send', status: 'failed', attempts: 3, lastError: 'x', finishedAt: new Date(), runAt: new Date(Date.now() - DAY) });
    expect((await post(stranger, `/health/jobs/${gaveUp._id}/retry`)).status).toBe(404);
    expect((await post(admin, `/health/jobs/${gaveUp._id}/retry`)).body.data).toEqual({ retried: 1 });
    expect(await Job.findById(gaveUp._id).lean()).toMatchObject({ status: 'queued', attempts: 0, lastError: '' });
    expect((await post(admin, `/health/jobs/${gaveUp._id}/retry`)).status).toBe(404);
    expect(await AuditLog.exists({ action: 'platform.job_retried' })).toBeTruthy();
  });
});
