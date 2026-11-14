const app = require('../app');
const env = require('../config/env');
const PlatformSetting = require('../models/PlatformSetting');
const { rehearse, report } = require('../../scripts/launch-rehearsal');

// The launch rehearsal's automatic part (100 phases, phase 10, D153; docs/LAUNCH_REHEARSAL.md):
// `npm run rehearsal -- <address>` looks at a running CRM from outside and says what is ready.
// Here it looks at this CRM on a local port, as it would at staging or production.
describe('Launch rehearsal', () => {
  let server;
  let origin;
  const saved = {};

  beforeAll(async () => {
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    origin = `http://127.0.0.1:${server.address().port}`;
    Object.assign(saved, { publicUrl: env.publicUrl, seller: { ...env.billing.seller } });
  });
  afterAll(async () => {
    env.publicUrl = saved.publicUrl;
    Object.assign(env.billing.seller, saved.seller);
    await new Promise((resolve) => { server.close(resolve); });
  });
  afterEach(async () => {
    env.publicUrl = saved.publicUrl;
    Object.assign(env.billing.seller, saved.seller);
    await PlatformSetting.deleteMany({ key: 'support' });
  });

  const line = (result, name) => result.results.find((r) => r.name === name);

  it('passes what a ready CRM shows from outside, and lists what is still to do', async () => {
    env.publicUrl = origin;
    const result = await rehearse(origin);
    const failed = result.results.filter((r) => r.level === 'FAIL');
    expect(failed).toEqual([]);
    for (const name of ['Server and database', 'The root address', 'Page index.html', 'Page status.html', 'Page agreem360.html', 'An unknown page', 'The status page address', 'Security headers', 'PUBLIC_URL', 'Status', 'Plans', 'Phone app']) {
      expect({ name, level: line(result, name).level }).toEqual({ name, level: 'PASS' });
    }
    expect(line(result, 'Plans').detail).toBe('5 plans, 45-day free trial on growth');
    // A local address is fine for a try, not for launch; the seller and support are not set here.
    expect(line(result, 'HTTPS').level).toBe('WARN');
    expect(line(result, 'Your legal details').detail).toMatch(/BILLING_SELLER_GSTIN/);
    expect(line(result, 'Support details').detail).toMatch(/platform admin page → Support/);
    expect(report(result)).toMatch(/0 failed\.\nReady to rehearse; the WARN lines are still to do/);
  });

  it('says plainly when PUBLIC_URL is not the address opened', async () => {
    env.publicUrl = 'https://crm.example.in';
    const result = await rehearse(origin);
    expect(line(result, 'PUBLIC_URL')).toMatchObject({ level: 'FAIL', detail: `the server says https://crm.example.in, but you opened ${origin} — set PUBLIC_URL on Render` });
    expect(result.failed).toBe(1);
    expect(report(result)).toMatch(/Fix every FAIL before launch/);
  });

  it('passes the legal and support details once they are set', async () => {
    env.publicUrl = origin;
    Object.assign(env.billing.seller, { name: 'Agreem Software', address: 'Jaipur, Rajasthan', gstin: '08AAACA1234A1Z5', email: 'billing@agreem360.com' });
    await PlatformSetting.create({ key: 'support', value: { whatsapp: '+919829012345', email: 'support@agreem360.com', hours: '10 am – 7 pm' } });
    const result = await rehearse(origin);
    expect(line(result, 'Your legal details')).toMatchObject({ level: 'PASS', detail: 'Agreem Software, GSTIN 08AAACA1234A1Z5' });
    expect(line(result, 'Support details')).toMatchObject({ level: 'PASS' });
  });

  it('a server that does not answer fails each check with the reason, and the others still run', async () => {
    const refuse = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
    const result = await rehearse('https://crm.example.in', { fetchImpl: refuse });
    expect(line(result, 'Server and database')).toMatchObject({ level: 'FAIL', detail: 'no answer (ECONNREFUSED)' });
    expect(line(result, 'HTTPS').level).toBe('PASS');
    expect(result.results.length).toBeGreaterThan(15);
    expect(result.results.filter((r) => r.level === 'FAIL').length).toBe(result.results.length - 1);
  });
});
