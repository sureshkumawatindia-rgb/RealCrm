jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const http = require('http');
const env = require('../config/env');
const Job = require('../models/Job');
const Lead = require('../models/Lead');
const Project = require('../models/Project');
const Organization = require('../models/Organization');
const queue = require('../jobs/queue');
const errorReporter = require('../services/errorReporter');
const telephony = require('../integrations/telephony');
const sms = require('../integrations/sms');
const microsoft = require('../integrations/microsoft');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// The foundation's first week (docs/FOUNDATION_30_DAY_PLAN.md): error reports to Sentry (F3), the
// health answer the watchdog reads (F3), and staging (F2): made-up data and no real providers.

// A stand-in Sentry that keeps what it receives.
function fakeSentry(status = 200, headers = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body });
      res.writeHead(status, headers);
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      received,
      port: server.address().port,
      close: () => new Promise((done) => {
        server.closeAllConnections(); // fetch keeps connections open
        server.close(done);
      }),
    }));
  });
}

afterEach(() => jest.restoreAllMocks());

describe('Error reports (F3)', () => {
  it('sends Sentry envelopes without customers\' data, once per error a minute, and honours 429', async () => {
    const sentry = await fakeSentry();
    let clock = 1_000_000;
    const reporter = createWith(sentry.port, () => clock);
    const error = new TypeError('Lead for raj@example.com (+91 98290 80601) failed, token=s3cr3tvalue');
    await reporter.capture(error, { req: { method: 'POST', originalUrl: '/api/v1/leads/6adb41393795a2da8ae4a1c2?token=x', member: { _id: 'm1' }, tenant: { organizationId: 'o1' }, id: 'r1' } });
    expect(sentry.received).toHaveLength(1);
    const [{ url, headers, body }] = sentry.received;
    expect(url).toBe('/api/42/envelope/');
    expect(headers['content-type']).toBe('application/x-sentry-envelope');
    expect(headers['x-sentry-auth']).toBe('Sentry sentry_version=7, sentry_client=yellow-crm/1.0, sentry_key=publickey');
    const [envelope, item, payload] = body.trim().split('\n').map((line) => JSON.parse(line));
    expect(envelope.event_id).toMatch(/^[a-f0-9]{32}$/);
    expect(item).toEqual({ type: 'event', length: Buffer.byteLength(JSON.stringify(payload)) });
    expect(payload).toMatchObject({
      level: 'error', environment: 'testing', release: 'abc1234',
      tags: { source: 'server', organization: 'o1' },
      request: { method: 'POST', url: '/api/v1/leads/6adb41393795a2da8ae4a1c2' },
      user: { id: 'm1' },
    });
    expect(payload.exception.values[0]).toMatchObject({ type: 'TypeError', value: 'Lead for [email] ([number]) failed, token=[secret]' });
    expect(payload.exception.values[0].stacktrace.frames.at(-1).filename).toBe('backend/src/tests/foundation.test.js');
    expect(body).not.toMatch(/raj@example|98290|s3cr3tvalue/);

    // The same error again within a minute: not sent; a minute later: sent.
    expect(reporter.capture(error)).toBeNull();
    clock += 61 * 1000;
    await reporter.capture(error);
    expect(sentry.received).toHaveLength(2);
    await sentry.close();

    // Sentry says "too many": nothing more until Retry-After has passed.
    const busy = await fakeSentry(429, { 'Retry-After': '120' });
    const paused = createWith(busy.port, () => clock);
    await paused.capture(new Error('first'));
    expect(paused.capture(new Error('second'))).toBeNull();
    clock += 121 * 1000;
    await paused.capture(new Error('third'));
    expect(busy.received).toHaveLength(2);
    await busy.close();

    // No DSN: nothing is sent.
    expect(errorReporter.createReporter({ dsn: '' }).capture(new Error('x'))).toBeNull();
  });

  it('reports the API\'s 5xx answers, jobs that gave up and page errors, not 4xx', async () => {
    const capture = jest.spyOn(errorReporter, 'capture').mockReturnValue(null);
    const owner = await login('f3-owner@example.com');
    expect((await api().post('/api/v1/dev/test-error').set(bearer(owner.token))).status).toBe(500);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][0].message).toBe('Test error from the developer tools (F3)');
    expect(capture.mock.calls[0][1].req.originalUrl).toBe('/api/v1/dev/test-error');
    expect((await api().get('/api/v1/leads/not-an-id').set(bearer(owner.token))).status).toBe(400);
    expect((await api().get('/api/v1/nothing-here')).status).toBe(404);
    expect(capture).toHaveBeenCalledTimes(1);

    queue.define('f3.always-fails', () => { throw new Error('Supplier API down'); }, { maxAttempts: 1 });
    await queue.enqueue('f3.always-fails', {});
    await queue.runDue();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[1][1]).toEqual({ source: 'job', tags: { job: 'f3.always-fails' } });

    const page = await api().post('/api/v1/client-errors').send({ message: 'Uncaught TypeError: x.map is not a function', stack: 'TypeError: x.map is not a function\n    at render (http://crm.example.com/crm/frontend/js/deals.js:10:5)', page: '/crm/frontend/Deals.html' });
    expect(page.status).toBe(204);
    expect(capture.mock.calls[2][0]).toMatchObject({ name: 'TypeError', message: 'x.map is not a function' });
    expect(capture.mock.calls[2][1]).toEqual({ source: 'page', platform: 'javascript', page: '/crm/frontend/Deals.html' });
    expect((await api().post('/api/v1/client-errors').send({ stack: 'no message' })).status).toBe(400);
  });
});

describe('Health (F3)', () => {
  it('says which copy this is, its version and whether jobs are late', async () => {
    const res = await api().get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'UP', environment: 'test', version: null, queueDelaySeconds: 0 });
    const late = await Job.create({ name: 'f3.late', status: 'queued', runAt: new Date(Date.now() - 20 * 60 * 1000), maxAttempts: 1 });
    const degraded = (await api().get('/api/v1/health')).body.data;
    expect(degraded.status).toBe('DEGRADED');
    expect(degraded.queueDelaySeconds).toBeGreaterThanOrEqual(1200);
    await Job.deleteOne({ _id: late._id });
  });
});

describe('Staging (F2)', () => {
  it('fills a company with made-up data once, for owners and admins', async () => {
    const owner = await login('f2-owner@example.com', { name: 'Neha' });
    const agent = await inviteAndJoin(owner.token, 'f2-agent@example.com', { role: 'agent' });
    expect((await api().post('/api/v1/staging/sample-data').set(bearer(agent.token))).status).toBe(403);

    const res = await api().post('/api/v1/staging/sample-data').set(bearer(owner.token));
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ products: 4, customers: 10, leads: 10, tasks: 6, projects: 1 });
    const organizationId = owner.data.organizationId;
    const stages = (await Lead.find({ organizationId }).select('stage').lean()).map((l) => l.stage).sort();
    expect(stages).toEqual(['Contacted', 'Contacted', 'Lost', 'Negotiation', 'New', 'New', 'Quote Sent', 'Quote Sent', 'Won', 'Won']);
    const project = await Project.findOne({ organizationId });
    expect(project.name).toBe('Rooftop 10 kW — Bhatia Farms');
    expect((await api().get(`/api/v1/projects/${project._id}`).set(bearer(owner.token))).body.data.progress).toBe(25);
    expect((await Organization.findById(organizationId)).settings.sampleDataAt).toBeTruthy();
    // Once.
    expect((await api().post('/api/v1/staging/sample-data').set(bearer(owner.token))).body.code).toBe('SAMPLE_DATA_EXISTS');
  });

  it('is not there in production', async () => {
    jest.spyOn(env, 'devTools', 'get').mockReturnValue(false);
    const owner = await login('f2-prod@example.com');
    expect((await api().post('/api/v1/staging/sample-data').set(bearer(owner.token))).status).toBe(404);
    expect((await api().post('/api/v1/dev/test-error').set(bearer(owner.token))).status).toBe(404);
  });

  it('uses only the test stand-ins, so nothing reaches real customers', async () => {
    const owner = await login('f2-guard@example.com');
    env.isStaging = true;
    try {
      expect(telephony.providerFor('exotel')).toBeNull();
      expect(telephony.providerFor('mock')).toBeTruthy();
      expect(sms.providerFor('msg91')).toBeNull();
      expect(sms.providerFor('mock')).toBeTruthy();
      expect(microsoft.mode()).toBe('mock');
      const real = await api().post('/api/v1/whatsapp/accounts').set(bearer(owner.token))
        .send({ provider: 'meta', phoneNumberId: '123456789012345', accessToken: 'EAAG-test-access-token-123456', appSecret: 'abcdef0123456789abcdef' });
      expect(real.status).toBe(400);
      expect(real.body.code).toBe('STAGING_TEST_NUMBERS_ONLY');
      expect((await api().get('/api/v1/health')).body.data.environment).toBe('test'); // appEnv is fixed at start
    } finally {
      env.isStaging = false;
    }
    expect(telephony.providerFor('exotel')).toBeTruthy();
  });
});

function createWith(port, now) {
  return errorReporter.createReporter({ dsn: `http://publickey@127.0.0.1:${port}/42`, environment: 'testing', release: 'abc1234', now });
}
