const crypto = require('crypto');
const path = require('path');
const env = require('../config/env');
const logger = require('../config/logger');

// Error reports to Sentry (F3), by its envelope protocol (develop.sentry.dev: POST
// /api/<project>/envelope/ with X-Sentry-Auth, protocol version 7) without its SDK.
// What is sent: the error's type, its message and stack with phone numbers, emails and secrets
// taken out, the method and path (never the query, headers or body), and member/company ids.
// Without a DSN nothing is sent. At most 30 reports a minute; the same error once a minute;
// Sentry's 429 is honoured; a failed send is dropped, never retried.

const MAX_PER_MINUTE = 30;
const SAME_ERROR_MS = 60 * 1000;
const SEND_TIMEOUT_MS = 5000;
const ROOT = path.resolve(__dirname, '..', '..', '..');

// Phone numbers, emails, bearer tokens and key=value secrets out of any text that is sent.
function scrub(text, max = 2000) {
  return String(text ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [secret]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]')
    .replace(/\b(token|secret|password|passwd|key|otp|signature)(["']?\s*[:=]\s*["']?)[^\s"',&]+/gi, '$1$2[secret]')
    .replace(/\+?\d[\d\s-]{8,}\d/g, (match) => (match.replace(/\D/g, '').length >= 10 ? '[number]' : match))
    .slice(0, max);
}

// A path without its query, and with long opaque parts (signed links, webhook keys) hidden.
// Record ids (24 hex characters) stay: they are not personal and help find the record.
function safePath(url) {
  return String(url || '').split('?')[0].split('/')
    .map((part) => (part.length >= 20 && !/^[a-f0-9]{24}$/i.test(part) ? '…' : part))
    .join('/')
    .slice(0, 300);
}

function parseDsn(dsn) {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const parts = url.pathname.split('/').filter(Boolean);
    const projectId = parts.pop();
    if (!url.username || !projectId) return null;
    const prefix = parts.length ? `/${parts.join('/')}` : '';
    return { endpoint: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`, publicKey: decodeURIComponent(url.username) };
  } catch {
    return null;
  }
}

// "    at fn (file:line:col)", "    at file:line:col" (Node, Chrome) and "fn@file:line:col"
// (Firefox, Safari) into Sentry frames, oldest call first.
function framesOf(stack) {
  const frames = [];
  for (const line of String(stack || '').split('\n').slice(0, 60)) {
    const v8 = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    const gecko = !v8 && /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/.exec(line);
    const match = v8 || gecko;
    if (!match) continue;
    let file = match[2].replace(/^file:\/\//, '');
    if (/^https?:\/\//.test(file)) {
      try {
        file = safePath(new URL(file).pathname);
      } catch {
        continue;
      }
    } else if (path.isAbsolute(file)) file = path.relative(ROOT, file).split(path.sep).join('/');
    frames.push({
      function: match[1] || '?',
      filename: file,
      lineno: Number(match[3]),
      colno: Number(match[4]),
      in_app: !file.includes('node_modules') && !file.startsWith('node:'),
    });
  }
  return frames.reverse();
}

function createReporter({ dsn, environment, release, fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const target = parseDsn(dsn);
  const recent = new Map(); // fingerprint → last sent
  const pending = new Set();
  let windowStart = 0;
  let windowCount = 0;
  let pausedUntil = 0;
  let warned = false;

  function allowed(fingerprint) {
    const at = now();
    if (at < pausedUntil) return false;
    if (at - windowStart >= 60 * 1000) {
      windowStart = at;
      windowCount = 0;
    }
    if (windowCount >= MAX_PER_MINUTE) return false;
    const last = recent.get(fingerprint);
    if (last && at - last < SAME_ERROR_MS) return false;
    windowCount += 1;
    recent.set(fingerprint, at);
    if (recent.size > 500) recent.delete(recent.keys().next().value);
    return true;
  }

  async function send(event) {
    const payload = JSON.stringify(event);
    const body = `${JSON.stringify({ event_id: event.event_id, sent_at: new Date(now()).toISOString() })}\n${JSON.stringify({ type: 'event', length: Buffer.byteLength(payload) })}\n${payload}\n`;
    try {
      const response = await fetchImpl(target.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=yellow-crm/1.0, sentry_key=${target.publicKey}`,
        },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after')) || 60;
        pausedUntil = now() + seconds * 1000;
      } else if (!response.ok && !warned) {
        warned = true;
        logger.warn(`Error reports: Sentry answered ${response.status}; check SENTRY_DSN.`);
      }
    } catch (error) {
      if (!warned) {
        warned = true;
        logger.warn(`Error reports could not reach Sentry: ${error.message}`);
      }
    }
  }

  // error: an Error (or anything thrown); context: { req, source, tags, platform, page }.
  function capture(error, context = {}) {
    if (!target) return null;
    const type = String(error?.name || error?.constructor?.name || 'Error').slice(0, 100);
    const value = scrub(error?.message ?? error, 1000);
    const frames = framesOf(error?.stack);
    const top = frames[frames.length - 1];
    const fingerprint = `${type}|${value}|${top ? `${top.filename}:${top.lineno}` : ''}`;
    if (!allowed(fingerprint)) return null;

    const { req } = context;
    const event = {
      event_id: crypto.randomUUID().replace(/-/g, ''),
      timestamp: now() / 1000,
      platform: context.platform || 'node',
      level: 'error',
      environment,
      ...(release && { release }),
      tags: {
        source: context.source || 'server',
        ...(req?.tenant?.organizationId && { organization: String(req.tenant.organizationId) }),
        ...(context.page && { page: safePath(context.page) }),
        ...context.tags,
      },
      exception: { values: [{ type, value, ...(frames.length && { stacktrace: { frames } }) }] },
      ...(req && { request: { method: req.method, url: safePath(req.originalUrl || req.url) } }),
      ...(req?.member?._id && { user: { id: String(req.member._id) } }),
      ...(req?.id && { extra: { requestId: String(req.id) } }),
    };
    const task = send(event).finally(() => pending.delete(task));
    pending.add(task);
    return task;
  }

  // Waits for reports on their way (a crash waits before the process ends).
  async function flush(timeoutMs = 2000) {
    if (!pending.size) return;
    await Promise.race([Promise.allSettled([...pending]), new Promise((resolve) => { setTimeout(resolve, timeoutMs).unref?.(); })]);
  }

  return { capture, flush, enabled: Boolean(target) };
}

const reporter = createReporter({ dsn: env.sentry.dsn, environment: env.sentry.environment, release: env.release });

module.exports = {
  capture: (...args) => reporter.capture(...args),
  flush: (...args) => reporter.flush(...args),
  enabled: reporter.enabled,
  createReporter,
  scrub,
  safePath,
  framesOf,
  parseDsn,
};
