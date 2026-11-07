/**
 * The Inbox on a phone's 4G (Phase 7, D119; docs/PHONE_APP.md): how long until the chats show on
 * the first open and the next ones, how long a chat takes to open, how much data that costs, and
 * whether the app opens with no network at all. In Chromium with Chrome's own 4G settings and a
 * budget phone's speed (the CPU 4× slower), against e2e/server.js (an in-memory database; nothing
 * real is reached): a company with 60 chats, in Hindi (the heavier language) and English.
 *
 *   npm run bench:phone                      (in backend/; about three minutes)
 *   npm run bench:phone -- --no-sw           as before the phone app: no service worker
 *   npm run bench:phone -- --runs=5 --waterfall --out=results.json
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { signIn } = require('../e2e/helpers');

const BACKEND = path.resolve(__dirname, '..');
const PORT = Number(process.env.BENCH_PORT || 3300);
const BASE = `http://127.0.0.1:${PORT}`;
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => (args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || fallback;
const RUNS = Number(option('runs', 3));
const OUT = option('out', '');
const SERVICE_WORKERS = flag('no-sw') ? 'block' : 'allow';
const LANGUAGES = option('languages', 'hi,en').split(',');

// Chrome DevTools' own 4G settings (per request: the delay, then the speed down and up).
const PROFILES = {
  'Slow 4G': { latency: 562.5, downloadThroughput: (1.47456 * 1e6) / 8, uploadThroughput: (0.675 * 1e6) / 8 },
  'Fast 4G': { latency: 165, downloadThroughput: (9 * 1e6) / 8, uploadThroughput: (1.5 * 1e6) / 8 },
};
const CPU_SLOWDOWN = 4; // a budget Android phone (as Google's PageSpeed test for phones)
const CHATS = 60;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};
const kb = (bytes) => Math.round(bytes / 1024);
const owner = { email: 'owner@phone.test', name: 'Phone Owner' };

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 180 * 1000) {
    try {
      const response = await fetch(`${BASE}/api/v1/health`);
      if (response.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('The e2e server did not start in 3 minutes.');
}

// A company with a test WhatsApp number and 60 chats (3 messages from each customer, our reply
// in every second chat).
async function seed(request) {
  const res = await request.post('/api/v1/auth/google', { data: { credential: `test:e2e-${owner.email}:${owner.email}:${owner.name}` } });
  const { token } = (await res.json()).data;
  const call = async (method, p, data) => {
    const response = await request.fetch(`/api/v1${p}`, { method, headers: { Authorization: `Bearer ${token}` }, ...(data && { data }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok()) throw new Error(`${method} ${p}: ${response.status()} ${JSON.stringify(body)}`);
    return body.data;
  };
  await call('POST', '/whatsapp/accounts', { provider: 'mock', name: 'Test number' });
  const texts = ['Namaste, jeera ka rate kya hai?', '25 kg chahiye, Jaipur delivery.', 'GST bill milega na?'];
  for (let i = 0; i < CHATS; i += 1) {
    let conversationId;
    for (const text of texts) {
      ({ conversationId } = await call('POST', '/dev/simulate/whatsapp-inbound', { from: `+91982900${1000 + i}`, name: `Customer ${i + 1}`, type: 'text', text }));
    }
    if (i % 2 === 0) await call('POST', `/conversations/${conversationId}/messages`, { text: 'Namaste! 25 kg jeera ₹250 per kg hai, GST bill ke saath.' });
  }
  return call;
}

// Times inside the page, from the start of its navigation: the first chat in the list, the first
// message of an opened chat, and the offline note.
function markTimes() {
  window.__marks = {};
  const check = () => {
    const now = performance.now();
    if (!window.__marks.chats && document.querySelector('.conv-item')) window.__marks.chats = now;
    if (!window.__marks.messages && document.querySelector('#messageList .msg')) window.__marks.messages = now;
  };
  new MutationObserver(check).observe(document, { childList: true, subtree: true });
}

async function phoneContext(browser) {
  const context = await browser.newContext({
    baseURL: BASE,
    serviceWorkers: SERVICE_WORKERS,
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  await signIn(context, owner);
  await context.addInitScript(markTimes);
  return context;
}

async function throttle(page, profile) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, ...PROFILES[profile] });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
  const requests = new Map();
  cdp.on('Network.requestWillBeSent', (e) => requests.set(e.requestId, { url: e.request.url, start: e.timestamp, bytes: 0 }));
  cdp.on('Network.loadingFinished', (e) => {
    const r = requests.get(e.requestId);
    if (r) Object.assign(r, { bytes: e.encodedDataLength, end: e.timestamp });
  });
  cdp.on('Network.requestServedFromCache', (e) => {
    const r = requests.get(e.requestId);
    if (r) r.cache = true;
  });
  return {
    // No network at all, on this page's own connection (where the 4G settings are) and the context's.
    offline: async (off) => {
      await cdp.send('Network.emulateNetworkConditions', off ? { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } : { offline: false, ...PROFILES[profile] });
      await page.context().setOffline(off);
    },
    reset: () => requests.clear(),
    bytes: () => [...requests.values()].reduce((sum, r) => sum + (r.bytes || 0), 0),
    waterfall: () => {
      const all = [...requests.values()].filter((r) => r.end);
      const t0 = Math.min(...all.map((r) => r.start));
      return all.map((r) => ({ url: r.url.replace(BASE, ''), kb: kb(r.bytes), from: Math.round((r.start - t0) * 1000), to: Math.round((r.end - t0) * 1000) })).sort((a, b) => a.from - b.from);
    },
  };
}

const at = (name) => `${BASE}/crm/frontend/${name}`;
async function openInbox(page) {
  await page.goto(at('Inbox.html'), { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__marks?.chats, null, { timeout: 120 * 1000, polling: 50 });
  return page.evaluate(() => Math.round(window.__marks.chats));
}
async function openChat(page) {
  const started = await page.evaluate(() => {
    window.__marks.messages = 0;
    return performance.now();
  });
  await page.locator('.conv-item').nth(1).click();
  await page.waitForFunction(() => window.__marks?.messages, null, { timeout: 120 * 1000, polling: 50 });
  return page.evaluate((from) => Math.round(window.__marks.messages - from), started);
}
// The service worker has its files (it says so on the page, Phase 7), or 20 seconds.
async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  if (SERVICE_WORKERS !== 'allow') return;
  await page.waitForFunction(() => !('serviceWorker' in navigator) || document.documentElement.dataset.appReady === '1' || window.__appReadyTimeout, null, { timeout: 20 * 1000 }).catch(() => {});
}

async function measure(browser, profile) {
  const result = { cold: [], coldKb: [], warm: [], warmKb: [], chat: [], offline: null };
  for (let run = 0; run < RUNS; run += 1) {
    const context = await phoneContext(browser);
    const page = await context.newPage();
    const net = await throttle(page, profile);
    result.cold.push(await openInbox(page));
    await settle(page);
    result.coldKb.push(kb(net.bytes()));
    if (run === 0 && flag('waterfall')) result.coldWaterfall = net.waterfall();
    net.reset();
    result.warm.push(await openInbox(page));
    await page.waitForLoadState('networkidle').catch(() => {});
    result.warmKb.push(kb(net.bytes()));
    if (run === 0 && flag('waterfall')) result.warmWaterfall = net.waterfall();
    // A person looks at the list for a few seconds before opening a chat (since Phase 7 the
    // newest chats are kept on the phone meanwhile).
    await page.waitForTimeout(5000);
    result.chat.push(await openChat(page));
    if (run === 0) {
      // No network at all: does the Inbox open, with its chats?
      await net.offline(true);
      try {
        await page.goto(at('Inbox.html'), { waitUntil: 'commit' });
        await page.waitForFunction(() => window.__marks?.chats, null, { timeout: 20 * 1000, polling: 100 });
        result.offline = `opens, ${await page.locator('.conv-item').count()} chats`;
      } catch {
        const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 100);
        result.offline = `no chats: ${text || '(the browser\'s own error page)'}`;
      }
      await net.offline(false);
    }
    await context.close();
  }
  return {
    'first open: chats show (ms)': median(result.cold),
    'first open: data (KB)': median(result.coldKb),
    'next open: chats show (ms)': median(result.warm),
    'next open: data (KB)': median(result.warmKb),
    'a chat opens (ms)': median(result.chat),
    'no network': result.offline,
    ...(result.coldWaterfall && { waterfall: { first: result.coldWaterfall, next: result.warmWaterfall } }),
    runs: { cold: result.cold, warm: result.warm, chat: result.chat },
  };
}

(async () => {
  const server = spawn(process.execPath, [path.join(BACKEND, 'e2e', 'server.js')], { env: { ...process.env, E2E_PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  let browser;
  const results = {};
  try {
    await waitForServer();
    browser = await chromium.launch();
    const setup = await browser.newContext({ baseURL: BASE });
    const call = await seed(setup.request);
    for (const language of LANGUAGES) {
      await call('PATCH', '/auth/preferences', { language });
      for (const profile of Object.keys(PROFILES)) {
        const key = `${language === 'hi' ? 'Hindi' : 'English'}, ${profile}`;
        process.stdout.write(`${key} …\n`);
        results[key] = await measure(browser, profile);
        const { waterfall, runs, ...summary } = results[key];
        console.table(summary);
      }
    }
    await setup.close();
    if (OUT) fs.writeFileSync(OUT, JSON.stringify({ serviceWorkers: SERVICE_WORKERS, runs: RUNS, cpuSlowdown: CPU_SLOWDOWN, results }, null, 2));
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
