// AgreemCRM alert watchdog (F3, docs/FOUNDATION_SETUP_STEPS.md). A Cloudflare Worker, outside the
// CRM, so it can still speak when the CRM is down. Every 2 minutes (a Cron Trigger) it asks each
// site's /api/v1/health. After 2 failed checks in a row (so within about 5 minutes) it sends one
// WhatsApp alert (the WhatsApp
// Cloud API, an approved template); while the site stays down, a reminder every 2 hours; when it
// is back, one "back up" message. UptimeRobot sends the emails; this sends the WhatsApp.
//
// Settings (Cloudflare → the Worker → Settings → Variables and Secrets):
//   SITES            "Production|https://…/api/v1/health,Staging|https://…/api/v1/health"
//   WA_PHONE_NUMBER_ID, WA_TOKEN (secret), WA_TO (numbers with country code, comma-separated)
//   WA_TEMPLATE      the approved template's name (default crm_alert), WA_LANG (default en)
//   GRAPH_VERSION    the Graph API version (default v26.0)
//   TEST_KEY (secret) for GET /test?key=… which sends a test message
// Binding: a KV namespace named STATE (remembers what was last seen between runs; written only
// when something changes, which keeps it far inside KV's free daily writes).

const FAILURES_FOR_ALERT = 2;
const REMIND_EVERY_MS = 2 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10000;

export function parseSites(text) {
  return String(text || '').split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [name, url] = entry.includes('|') ? entry.split('|') : ['CRM', entry];
    return { name: name.trim(), url: url.trim() };
  }).filter((site) => /^https?:\/\//.test(site.url));
}

// One check: { ok, reason }. Not 200, no answer in 10 seconds, or a status other than UP fails.
export async function checkSite(site, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(site.url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), headers: { 'User-Agent': 'yellow-crm-watchdog' } });
    if (response.status !== 200) return { ok: false, reason: `answered ${response.status}` };
    const body = await response.json().catch(() => null);
    const status = body?.data?.status;
    if (status === 'UP') return { ok: true };
    if (status === 'DEGRADED') return { ok: false, reason: `background jobs are ${Math.round((body.data.queueDelaySeconds || 0) / 60)} minutes late` };
    return { ok: false, reason: `health says ${status || 'nothing'}` };
  } catch (error) {
    return { ok: false, reason: error?.name === 'TimeoutError' ? 'no answer in 10 seconds' : 'could not be reached' };
  }
}

const minutes = (ms) => Math.max(1, Math.round(ms / 60000));

// What was known + this check → what to remember, and the message to send (if any).
export function decide(previous, result, site, now) {
  const state = { failures: 0, down: false, since: null, alertedAt: null, ...previous };
  if (result.ok) {
    if (state.down) return { state: { failures: 0, down: false, since: null, alertedAt: null }, message: `${site.name} is back up after ${minutes(now - state.since)} minutes` };
    return { state: { ...state, failures: 0 }, message: null };
  }
  const failures = state.failures + 1;
  const since = state.since ?? now;
  if (!state.down && failures >= FAILURES_FOR_ALERT) {
    return { state: { failures, down: true, since, alertedAt: now }, message: `${site.name} is DOWN: ${result.reason}` };
  }
  if (state.down && now - state.alertedAt >= REMIND_EVERY_MS) {
    return { state: { ...state, failures, alertedAt: now }, message: `${site.name} is still DOWN after ${minutes(now - since)} minutes: ${result.reason}` };
  }
  return { state: { ...state, failures, since }, message: null };
}

// One template message to each number. A template's variable may not hold new lines or tabs.
export async function sendWhatsApp(env, text, fetchImpl = fetch) {
  const numbers = String(env.WA_TO || '').split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean);
  if (!env.WA_TOKEN || !env.WA_PHONE_NUMBER_ID || !numbers.length) return { sent: 0, error: 'WhatsApp is not set up (WA_TOKEN, WA_PHONE_NUMBER_ID, WA_TO)' };
  const url = `https://graph.facebook.com/${env.GRAPH_VERSION || 'v26.0'}/${env.WA_PHONE_NUMBER_ID}/messages`;
  const clean = String(text).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').slice(0, 900);
  let sent = 0;
  let error = null;
  for (const to of numbers) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: { name: env.WA_TEMPLATE || 'crm_alert', language: { code: env.WA_LANG || 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: clean }] }] },
      }),
    }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
    if (response.ok) sent += 1;
    else error = `WhatsApp answered ${response.status}: ${(await response.text()).slice(0, 300)}`;
  }
  return { sent, error };
}

export async function runChecks(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const results = [];
  for (const site of parseSites(env.SITES)) {
    const result = await checkSite(site, fetchImpl);
    const key = `site:${site.name}`;
    const saved = env.STATE ? await env.STATE.get(key) : null;
    const { state, message } = decide(JSON.parse(saved || 'null'), result, site, now);
    const next = JSON.stringify(state);
    if (env.STATE && next !== (saved ?? JSON.stringify(decide(null, { ok: true }, site, now).state))) await env.STATE.put(key, next);
    const delivery = message ? await sendWhatsApp(env, `AgreemCRM: ${message}`, fetchImpl) : null;
    results.push({ site: site.name, ok: result.ok, reason: result.reason || null, message, delivery });
  }
  return results;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/test') {
      if (!env.TEST_KEY || url.searchParams.get('key') !== env.TEST_KEY) return new Response('Not found', { status: 404 });
      const delivery = await sendWhatsApp(env, 'AgreemCRM: test alert from the watchdog. Alerts reach this number.');
      return Response.json(delivery, { status: delivery.sent ? 200 : 502 });
    }
    if (url.pathname === '/check') {
      if (!env.TEST_KEY || url.searchParams.get('key') !== env.TEST_KEY) return new Response('Not found', { status: 404 });
      return Response.json(await runChecks(env));
    }
    return new Response('AgreemCRM watchdog', { status: 200 });
  },
};
