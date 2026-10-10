const KnownBrowser = require('../models/KnownBrowser');
const Session = require('../models/Session');
const env = require('../config/env');
const logger = require('../config/logger');
const { randomToken, hashToken } = require('../utils/tokens');
const { audit } = require('../utils/audit');
const notificationService = require('./notificationService');

// "New login" alerts (D63): someone logs in from a browser this person never used, and they get
// a note in the bell (and as web push on their devices): "New login: Chrome on Windows, 10:42 AM.
// Not you? Log out that device." It opens "Where you're logged in" (Settings → Your Profile).

const BROWSER_COOKIE = 'crm_browser';
const BROWSER_TTL_MS = 400 * 24 * 60 * 60 * 1000; // about as long as browsers keep a cookie
const AUTH_COOKIE_PATH = '/api/v1/auth';
const DEVICES_LINK = 'Settings.html?tab=profile#devicesSection';

function readBrowserCookie(req) {
  const header = req.get('cookie') || '';
  const part = header.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${BROWSER_COOKIE}=`));
  return part ? decodeURIComponent(part.slice(BROWSER_COOKIE.length + 1)) : '';
}

// Called before the new session is opened. → { known, cookie }: known = no alert; cookie = what
// the browser keeps (set on every login so it never runs out while in use).
async function recognize(req, user) {
  const userAgent = String(req.get('user-agent') || '').slice(0, 300);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + BROWSER_TTL_MS);
  const token = readBrowserCookie(req);
  const cookieFor = (value) => ({
    name: BROWSER_COOKIE,
    value,
    options: { httpOnly: true, sameSite: 'strict', secure: env.isProduction || req.secure, path: AUTH_COOKIE_PATH, maxAge: BROWSER_TTL_MS },
  });

  if (token) {
    const known = await KnownBrowser.findOneAndUpdate(
      { tokenHash: hashToken(token), userId: user._id },
      { $set: { lastLoginAt: now, userAgent, expiresAt } },
    );
    if (known) return { known: true, cookie: cookieFor(token) };
  }

  // Not this person's browser (no cookie, or someone else's). It is still no surprise:
  // - their very first login (the account is new);
  // - the first login since alerts exist: before then no browser had the cookie, so one with a
  //   session from this same browser is the one they use. Once they have a known browser, only
  //   the cookie counts.
  const [hadSession, anyKnown] = await Promise.all([
    Session.exists({ userId: user._id }),
    KnownBrowser.exists({ userId: user._id }),
  ]);
  const sameBrowserBefore = !anyKnown && hadSession && userAgent && await Session.exists({ userId: user._id, userAgent });
  const fresh = randomToken();
  await KnownBrowser.create({ userId: user._id, tokenHash: hashToken(fresh), userAgent, lastLoginAt: now, expiresAt });
  return { known: !hadSession || Boolean(sameBrowserBefore), cookie: cookieFor(fresh) };
}

const timeOf = (date) => new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(date);

// The alert for the member who just logged in (their bell is per company). Never holds up the
// login: a failure is only logged.
async function alertNewLogin(req, { user, member, device, at = new Date() }) {
  try {
    await notificationService.notify(member.organizationId, [member._id], {
      title: `New login: ${device}, ${timeOf(at)}`,
      body: 'Not you? Log out that device.',
      link: DEVICES_LINK,
      source: 'login-alert',
    });
    await audit(req, { organizationId: member.organizationId, action: 'auth.new_browser', entityType: 'User', entityId: user._id, changes: { device } });
  } catch (error) {
    logger.error(`New login alert failed: ${error.message}`);
  }
}

module.exports = { recognize, alertNewLogin, BROWSER_COOKIE, DEVICES_LINK };
