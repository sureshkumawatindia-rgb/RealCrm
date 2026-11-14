#!/usr/bin/env node
// The launch rehearsal's automatic part (100 phases, phase 10, D153; docs/LAUNCH_REHEARSAL.md).
// Looks at a running CRM from outside, the way a visitor, Meta and Razorpay will, and says what is
// ready and what is not. It needs no key and changes nothing (on production it only asks; the
// developer tools' check is a request that a production server must refuse).
//
//   npm run rehearsal -- https://crm.agreem360.com
//   npm run rehearsal -- https://<your-staging>.onrender.com
//   npm run rehearsal -- https://crm.agreem360.com --site https://agreem360.com
//
// Every line is PASS, WARN (works, but something is still to do) or FAIL (fix before launch).
// The exit code is 1 when anything failed.

const PUBLIC_PAGES = ['index.html', 'login.html', 'privacy.html', 'terms.html', 'refund.html', 'delivery.html', 'contact.html', 'status.html', 'agreem360.html'];
const PLAN_KEYS = ['starter', 'pro', 'growth', 'scale', 'infinite'];
const TIMEOUT_MS = 20000;
const SLOW_MS = 2000;

const isLocal = (url) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

async function rehearse(baseUrl, { site = '', fetchImpl = fetch } = {}) {
  const base = new URL(String(baseUrl).replace(/\/+$/, ''));
  const origin = base.origin;
  const results = [];
  const add = (level, name, detail = '') => results.push({ level, name, detail });
  const ask = async (path, options = {}) => {
    const started = Date.now();
    const response = await fetchImpl(new URL(path, origin), { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), ...options });
    return Object.assign(response, { took: Date.now() - started });
  };
  const json = async (path) => {
    const response = await ask(path);
    const body = await response.json().catch(() => null);
    return { response, body, data: body?.data };
  };
  // One check; a check that cannot even ask fails with the reason, the others go on.
  const check = async (name, run) => {
    try {
      await run();
    } catch (error) {
      add('FAIL', name, error.cause?.code || error.name === 'TimeoutError' ? `no answer (${error.cause?.code || 'timed out'})` : error.message);
    }
  };

  // 1. The server answers, with its database.
  let environment = '';
  await check('Server and database', async () => {
    const { response, data } = await json('/api/v1/health');
    environment = data?.environment || '';
    const about = `${data?.status || response.status}, ${environment || 'unknown'} copy${data?.version ? `, version ${String(data.version).slice(0, 7)}` : ''}`;
    if (response.status !== 200 || !data) return add('FAIL', 'Server and database', `answered ${response.status} (${about})`);
    if (data.status === 'DEGRADED') return add('WARN', 'Server and database', `${about}: background work is ${data.queueDelaySeconds} s late`);
    add(response.took > SLOW_MS ? 'WARN' : 'PASS', 'Server and database', `${about}, ${response.took} ms${response.took > SLOW_MS ? ' (slow: a free server waking up?)' : ''}`);
  });
  const production = environment === 'production';

  // 2. HTTPS, and plain http sent to it.
  if (base.protocol !== 'https:') {
    add(isLocal(base) ? 'WARN' : 'FAIL', 'HTTPS', isLocal(base) ? 'a local address (fine for a try, not for launch)' : 'the address must start with https://');
  } else {
    add('PASS', 'HTTPS', origin);
    await check('http:// goes to https://', async () => {
      const response = await fetchImpl(`http://${base.host}/`, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const to = response.headers.get('location') || '';
      add([301, 302, 307, 308].includes(response.status) && to.startsWith('https://') ? 'PASS' : 'WARN', 'http:// goes to https://', `${response.status}${to ? ` → ${to}` : ''}`);
    });
  }

  // 3. The pages anyone may open, and an unknown page.
  await check('The root address', async () => {
    const response = await ask('/');
    const to = response.headers.get('location') || '';
    add([301, 302].includes(response.status) && /\/crm\/frontend\/(index|agreem360)\.html$/.test(to) ? 'PASS' : 'FAIL', 'The root address', `${response.status}${to ? ` → ${to}` : ''}`);
  });
  for (const name of PUBLIC_PAGES) {
    await check(`Page ${name}`, async () => {
      const response = await ask(`/crm/frontend/${name}`);
      const html = (response.headers.get('content-type') || '').includes('text/html');
      add(response.status === 200 && html ? 'PASS' : 'FAIL', `Page ${name}`, `${response.status}`);
    });
  }
  await check('An unknown page', async () => {
    const response = await ask('/crm/frontend/no-such-page-launch-check.html');
    add(response.status === 404 ? 'PASS' : 'WARN', 'An unknown page', `${response.status} (404 expected)`);
  });
  await check('The status page address', async () => {
    const response = await ask('/status');
    add([301, 302].includes(response.status) && (response.headers.get('location') || '').endsWith('/crm/frontend/status.html') ? 'PASS' : 'FAIL', 'The status page address', `${origin}/status → ${response.status}`);
  });

  // 4. The pages' security headers.
  await check('Security headers', async () => {
    const response = await ask('/crm/frontend/login.html');
    const missing = [];
    if (!(response.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'")) missing.push('Content-Security-Policy');
    if ((response.headers.get('x-frame-options') || '').toUpperCase() !== 'DENY') missing.push('X-Frame-Options');
    if ((response.headers.get('x-content-type-options') || '') !== 'nosniff') missing.push('X-Content-Type-Options');
    if (production && base.protocol === 'https:' && !response.headers.get('strict-transport-security')) missing.push('Strict-Transport-Security');
    add(missing.length ? 'FAIL' : 'PASS', 'Security headers', missing.length ? `missing: ${missing.join(', ')}` : 'all there');
  });

  // 5. PUBLIC_URL is this address (search engines, emails, webhooks and OAuth all use it).
  await check('PUBLIC_URL', async () => {
    const response = await ask('/robots.txt');
    const text = await response.text();
    const sitemap = text.match(/^Sitemap:\s*(\S+)/m)?.[1] || '';
    if (response.status !== 200) return add('FAIL', 'PUBLIC_URL', `robots.txt answered ${response.status}`);
    if (!sitemap) {
      return add(production ? 'FAIL' : 'PASS', 'PUBLIC_URL', production ? 'robots.txt names no sitemap' : 'not production: search engines are kept out (fine)');
    }
    const publicUrl = new URL(sitemap).origin;
    add(publicUrl === origin ? 'PASS' : 'FAIL', 'PUBLIC_URL', publicUrl === origin ? publicUrl : `the server says ${publicUrl}, but you opened ${origin} — set PUBLIC_URL on Render`);
  });

  // 6. The status page's data.
  await check('Status', async () => {
    const { response, data } = await json('/api/v1/status');
    if (response.status !== 200 || !data) return add('FAIL', 'Status', `answered ${response.status}`);
    const trouble = (data.services || []).filter((s) => s.status !== 'ok').map((s) => `${s.key} ${s.status}`);
    add(data.status === 'ok' ? 'PASS' : 'WARN', 'Status', data.status === 'ok' ? 'everything is working' : trouble.join(', ') || data.status);
  });

  // 7. Who runs the CRM (the legal pages, plan invoices, Razorpay's website check).
  await check('Your legal details', async () => {
    const { data } = await json('/api/v1/site');
    if (!data) return add('FAIL', 'Your legal details', 'GET /api/v1/site did not answer');
    const missing = [['BILLING_SELLER_NAME', data.name && data.name !== 'agreem360'], ['BILLING_SELLER_ADDRESS', data.address], ['BILLING_SELLER_GSTIN', data.gstin], ['BILLING_SELLER_EMAIL', data.email]]
      .filter(([, value]) => !value).map(([key]) => key);
    add(missing.length ? 'WARN' : 'PASS', 'Your legal details', missing.length ? `still to set on Render: ${missing.join(', ')}` : `${data.name}, GSTIN ${data.gstin}`);
    const support = data.support || {};
    const supportMissing = [['WhatsApp', support.whatsapp], ['email', support.email], ['hours', support.hours]].filter(([, value]) => !value).map(([key]) => key);
    add(supportMissing.length ? 'WARN' : 'PASS', 'Support details', supportMissing.length ? `still to set on the platform admin page → Support: ${supportMissing.join(', ')}` : `${support.whatsapp}, ${support.email}, ${support.hours}`);
  });

  // 8. The plans and the free trial.
  await check('Plans', async () => {
    const { data } = await json('/api/v1/site/plans');
    const keys = (data?.plans || []).map((plan) => plan.key);
    const same = keys.length === PLAN_KEYS.length && PLAN_KEYS.every((key, index) => keys[index] === key);
    add(same ? 'PASS' : 'FAIL', 'Plans', same ? `${keys.length} plans, ${data.trialDays}-day free trial on ${data.trialPlan}` : `found: ${keys.join(', ') || 'none'}`);
  });

  // 9. The phone app's file list (Phase 7): the server writes it into sw.js.
  await check('Phone app', async () => {
    const response = await ask('/crm/frontend/sw.js');
    const text = await response.text();
    add(response.status === 200 && !text.includes('/*BUILD*/ null') ? 'PASS' : 'FAIL', 'Phone app', `sw.js ${response.status}${text.includes('/*BUILD*/ null') ? ', without its file list' : ''}`);
  });

  // 10. Meta's webhook: the address exists, and refuses what Meta did not sign.
  await check('Meta webhook', async () => {
    const verify = await ask('/api/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=launch-check-wrong&hub.challenge=1');
    const unsigned = await ask('/api/v1/webhooks/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (verify.status !== 403) return add('FAIL', 'Meta webhook', `the check answered ${verify.status} (403 expected)`);
    if (unsigned.status === 404) return add('WARN', 'Meta webhook', 'META_APP_SECRET is not set yet: Instagram, Messenger and Meta\'s lead forms cannot arrive');
    add(unsigned.status === 401 ? 'PASS' : 'FAIL', 'Meta webhook', unsigned.status === 401 ? 'refuses messages Meta did not sign' : `an unsigned message answered ${unsigned.status} (401 expected)`);
  });

  // 11. Production never has the developer tools.
  if (production) {
    await check('Developer tools off', async () => {
      const response = await ask('/api/v1/dev/status-check', { method: 'POST' });
      add(response.status === 404 ? 'PASS' : 'FAIL', 'Developer tools off', response.status === 404 ? 'not there' : `answered ${response.status}: DEV_TOOLS must be off in production`);
    });
  }

  // 12. agreem360's own website (optional).
  if (site) {
    await check('agreem360 website', async () => {
      const response = await fetchImpl(site, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await response.text();
      add(response.status === 200 && /agreem360/i.test(text) ? 'PASS' : 'FAIL', 'agreem360 website', `${site} → ${response.status} at ${response.url}`);
    });
  }

  return { origin, environment, results, failed: results.filter((r) => r.level === 'FAIL').length, warned: results.filter((r) => r.level === 'WARN').length };
}

function report({ origin, environment, results, failed, warned }) {
  const lines = [`Launch rehearsal for ${origin} (${environment || 'environment unknown'})`, ''];
  for (const r of results) lines.push(`${r.level.padEnd(4)}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  lines.push('', `${results.length - failed - warned} passed, ${warned} to do, ${failed} failed.`);
  lines.push(failed ? 'Fix every FAIL before launch (docs/LAUNCH_REHEARSAL.md).' : warned ? 'Ready to rehearse; the WARN lines are still to do (docs/LAUNCH_REHEARSAL.md).' : 'Everything checked from outside is ready.');
  return lines.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const siteAt = args.indexOf('--site');
  const site = siteAt >= 0 ? args.splice(siteAt, 2)[1] : '';
  const target = args[0];
  if (!target || !/^https?:\/\//.test(target)) {
    console.error('Usage: npm run rehearsal -- https://crm.agreem360.com [--site https://agreem360.com]');
    process.exit(2);
  }
  rehearse(target, { site }).then((result) => {
    console.log(report(result));
    process.exit(result.failed ? 1 : 0);
  }).catch((error) => {
    console.error(`The rehearsal could not run: ${error.message}`);
    process.exit(2);
  });
}

module.exports = { rehearse, report, PUBLIC_PAGES };
