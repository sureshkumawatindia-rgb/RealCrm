const env = require('../../config/env');

// Microsoft identity platform + Microsoft Graph (Phase 4B, D83), with fetch. Only what the CRM
// uses: sign-in with PKCE, refresh, who signed in, and the signed-in person's calendar events
// (a Teams link comes from isOnlineMeeting). Least scopes: no mail, files or contacts.
const SCOPES = Object.freeze(['openid', 'email', 'offline_access', 'User.Read', 'Calendars.ReadWrite']);
const GRAPH = 'https://graph.microsoft.com/v1.0';
const TIMEOUT_MS = 15000;
const authority = () => `https://login.microsoftonline.com/${env.microsoft.tenant}/oauth2/v2.0`;

// An error the service understands: reconnect (the person must connect again), retry (try later).
function failure(message, { status = 502, reconnect = false, retry = false } = {}) {
  return Object.assign(new Error(message), { statusCode: status, code: reconnect ? 'MICROSOFT_RECONNECT' : 'MICROSOFT_FAILED', reconnect, retry });
}

function authorizeUrl({ state, codeChallenge, redirectUri }) {
  const url = new URL(`${authority()}/authorize`);
  url.search = new URLSearchParams({
    client_id: env.microsoft.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

async function tokenRequest(params) {
  let response;
  try {
    response = await fetch(`${authority()}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.microsoft.clientId, client_secret: env.microsoft.clientSecret, scope: SCOPES.join(' '), ...params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw failure('Microsoft did not answer.', { retry: true });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    // invalid_grant: the refresh token was revoked or expired; the person connects again.
    if (body.error === 'invalid_grant' || body.error === 'interaction_required') throw failure('Microsoft 365 needs to be connected again.', { status: 409, reconnect: true });
    throw failure(`Microsoft refused the sign-in (${body.error || response.status}).`, { retry: response.status >= 500 });
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: Number(body.expires_in) || 3600, scope: String(body.scope || '').split(' ').filter(Boolean) };
}

const exchangeCode = ({ code, codeVerifier, redirectUri }) => tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier });
const refresh = ({ refreshToken }) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });

async function call(accessToken, method, path, body) {
  let response;
  try {
    response = await fetch(`${GRAPH}${path}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw failure('Microsoft did not answer.', { retry: true });
  }
  if (response.status === 204) return {};
  const answer = await response.json().catch(() => ({}));
  if (response.ok) return answer;
  if (response.status === 404 && method === 'DELETE') return {}; // already gone
  if (response.status === 401 || response.status === 403) throw failure('Microsoft 365 needs to be connected again.', { status: 409, reconnect: true });
  throw failure(`Microsoft answered ${response.status}${answer.error?.code ? ` (${answer.error.code})` : ''}.`, { retry: response.status === 429 || response.status >= 500, status: response.status === 404 ? 404 : 502 });
}

async function me(accessToken) {
  const user = await call(accessToken, 'GET', '/me?$select=id,displayName,mail,userPrincipalName');
  return { id: user.id, name: user.displayName || '', email: user.mail || user.userPrincipalName || '' };
}

const shape = (event) => ({ id: event.id, joinUrl: event.onlineMeeting?.joinUrl || '' });
const createEvent = async (accessToken, event) => shape(await call(accessToken, 'POST', '/me/events', event));
const updateEvent = async (accessToken, id, event) => shape(await call(accessToken, 'PATCH', `/me/events/${encodeURIComponent(id)}`, event));
const deleteEvent = async (accessToken, id) => { await call(accessToken, 'DELETE', `/me/events/${encodeURIComponent(id)}`); };

module.exports = { name: 'graph', SCOPES, authorizeUrl, exchangeCode, refresh, me, createEvent, updateEvent, deleteEvent, failure };
