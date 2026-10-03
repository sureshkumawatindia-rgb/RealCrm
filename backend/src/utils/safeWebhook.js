const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const httpError = require('./httpError');
const env = require('../config/env');

// Calls a webhook an automation step names (Phase 6). Only https to a public address: the
// server must never be turned into a tool for reaching its own network (127.0.0.1, 10.x,
// 192.168.x, cloud metadata 169.254.169.254 …). The body is signed with the workflow's secret:
// X-CRM-Signature: sha256=<HMAC of the exact body>. 10-second timeout; redirects are refused.
const TIMEOUT_MS = 10000;

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return privateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9')
    || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff');
}

let lookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });
// Tests replace the DNS lookup (no network in tests).
function setLookup(fn) {
  lookup = fn;
}

async function assertPublicHttps(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError(400, 'WEBHOOK_URL', 'The webhook address is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw httpError(400, 'WEBHOOK_URL', 'Webhook addresses must start with https://');
  if (url.username || url.password) throw httpError(400, 'WEBHOOK_URL', 'Put no user name or password in the webhook address.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw httpError(400, 'WEBHOOK_URL', 'Webhooks cannot go to this server\'s own network.');
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host).catch(() => []);
  if (!addresses.length) throw httpError(400, 'WEBHOOK_URL', `The address ${host} could not be found.`);
  if (addresses.some(({ address }) => privateAddress(address))) throw httpError(400, 'WEBHOOK_URL', 'Webhooks cannot go to a private or local network address.');
  return url;
}

// → { status }. Throws a 4xx httpError for a refused address (not retried) and a 502 for a
// failed or non-2xx call (the job retries it).
async function callWebhook(rawUrl, payload, secret) {
  const url = await assertPublicHttps(rawUrl);
  const body = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', secret || env.jwtSecret).update(body).digest('hex')}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'YellowCRM-Automation/1', 'X-CRM-Signature': signature, 'X-CRM-Event': String(payload.event || '') },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw httpError(502, 'WEBHOOK_FAILED', `The webhook at ${url.host} did not answer.`);
  }
  if (response.status < 200 || response.status >= 300) throw httpError(502, 'WEBHOOK_FAILED', `The webhook at ${url.host} answered ${response.status}.`);
  return { status: response.status };
}

module.exports = { callWebhook, assertPublicHttps, privateAddress, setLookup };
