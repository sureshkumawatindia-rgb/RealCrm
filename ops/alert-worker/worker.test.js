// The alert watchdog (F3): node --test worker.test.js (also in CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { parseSites, checkSite, decide, sendWhatsApp, runChecks } from './worker.js';

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const health = (status, extra = {}) => json({ data: { status, ...extra } });
const kv = () => {
  const store = new Map();
  return { store, get: async (key) => store.get(key) ?? null, put: async (key, value) => { store.set(key, value); } };
};
const MINUTE = 60 * 1000;

test('reads the sites', () => {
  assert.deepEqual(parseSites('Production|https://crm.example.com/api/v1/health, Staging|https://staging.example.com/api/v1/health,bad'), [
    { name: 'Production', url: 'https://crm.example.com/api/v1/health' },
    { name: 'Staging', url: 'https://staging.example.com/api/v1/health' },
  ]);
});

test('a check fails on a bad answer, a late queue or no answer', async () => {
  const site = { name: 'P', url: 'https://crm.example.com/api/v1/health' };
  assert.deepEqual(await checkSite(site, async () => health('UP')), { ok: true });
  assert.deepEqual(await checkSite(site, async () => json({}, 503)), { ok: false, reason: 'answered 503' });
  assert.deepEqual(await checkSite(site, async () => health('DEGRADED', { queueDelaySeconds: 1800 })), { ok: false, reason: 'background jobs are 30 minutes late' });
  assert.deepEqual(await checkSite(site, async () => { throw new TypeError('fetch failed'); }), { ok: false, reason: 'could not be reached' });
});

test('alerts once after two failures, reminds every 2 hours, and says when it is back', () => {
  const site = { name: 'Production' };
  const down = { ok: false, reason: 'answered 503' };
  let t = 0;
  let step = decide(null, down, site, t);
  assert.equal(step.message, null); // one failure is not enough
  step = decide(step.state, down, site, (t += 5 * MINUTE));
  assert.equal(step.message, 'Production is DOWN: answered 503');
  step = decide(step.state, down, site, (t += 5 * MINUTE));
  assert.equal(step.message, null); // no repeat every 5 minutes
  step = decide(step.state, down, site, (t += 2 * 60 * MINUTE));
  assert.match(step.message, /^Production is still DOWN after 130 minutes/);
  step = decide(step.state, { ok: true }, site, (t += 5 * MINUTE));
  assert.equal(step.message, 'Production is back up after 135 minutes');
  assert.equal(decide(step.state, { ok: true }, site, (t += 5 * MINUTE)).message, null);
  // A single blip never alerts.
  step = decide(null, down, site, 0);
  step = decide(step.state, { ok: true }, site, 5 * MINUTE);
  assert.equal(step.message, null);
});

test('sends the template to each number, on one line', async () => {
  const calls = [];
  const env = { WA_TOKEN: 't', WA_PHONE_NUMBER_ID: '123', WA_TO: '+91 98290 80601, 919829080602', WA_TEMPLATE: 'crm_alert' };
  const result = await sendWhatsApp(env, 'line one\nline two', async (url, options) => { calls.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization }); return json({}); });
  assert.deepEqual(result, { sent: 2, error: null });
  assert.equal(calls[0].url, 'https://graph.facebook.com/v26.0/123/messages');
  assert.equal(calls[0].auth, 'Bearer t');
  assert.deepEqual(calls.map((c) => c.body.to), ['919829080601', '919829080602']);
  assert.equal(calls[0].body.template.name, 'crm_alert');
  assert.equal(calls[0].body.template.components[0].parameters[0].text, 'line one line two');
  assert.deepEqual(await sendWhatsApp({}, 'x', async () => json({})), { sent: 0, error: 'WhatsApp is not set up (WA_TOKEN, WA_PHONE_NUMBER_ID, WA_TO)' });
});

test('a run checks every site and remembers between runs', async () => {
  const STATE = kv();
  const sent = [];
  const env = { SITES: 'Production|https://crm.example.com/api/v1/health', STATE, WA_TOKEN: 't', WA_PHONE_NUMBER_ID: '1', WA_TO: '919829080601' };
  const fetchImpl = async (url, options) => {
    if (url.includes('graph.facebook.com')) { sent.push(JSON.parse(options.body).template.components[0].parameters[0].text); return json({}); }
    return json({}, 502);
  };
  await runChecks(env, { fetchImpl, now: 0 });
  const [second] = await runChecks(env, { fetchImpl, now: 5 * MINUTE });
  assert.equal(second.message, 'Production is DOWN: answered 502');
  assert.deepEqual(sent, ['YELLOW CRM: Production is DOWN: answered 502']);
  assert.equal(JSON.parse(STATE.store.get('site:Production')).down, true);
});

test('a healthy site writes nothing, run after run', async () => {
  const puts = [];
  const STATE = { get: async () => null, put: async (key, value) => { puts.push([key, value]); } };
  const env = { SITES: 'Production|https://crm.example.com/api/v1/health', STATE };
  for (let i = 0; i < 3; i += 1) await runChecks(env, { fetchImpl: async () => health('UP'), now: i * 2 * MINUTE });
  assert.deepEqual(puts, []);
});

test('the test address needs the key', async () => {
  const response = await worker.fetch(new Request('https://w.example.com/test?key=wrong'), { TEST_KEY: 'right' });
  assert.equal(response.status, 404);
  assert.equal((await worker.fetch(new Request('https://w.example.com/'), {})).status, 200);
});
