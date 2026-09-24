const env = require('../config/env');

const REFRESH_COOKIE = 'crm_refresh';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

function readCookie(req, name) {
  const header = req.get('cookie') || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

// The refresh token lives in an httpOnly cookie that only the /auth endpoints receive.
function setRefreshCookie(req, res, token) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.isProduction || req.secure,
    path: REFRESH_COOKIE_PATH,
    maxAge: env.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(req, res) {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, sameSite: 'strict', secure: env.isProduction || req.secure, path: REFRESH_COOKIE_PATH });
}

module.exports = { REFRESH_COOKIE, readCookie, setRefreshCookie, clearRefreshCookie };
