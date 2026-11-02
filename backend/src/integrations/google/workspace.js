const { google } = require('googleapis');
const env = require('../../config/env');

// Google Workspace for one member (Phase 9, D90): sign-in, Gmail (read-only), Calendar events and
// Drive files the CRM makes, through googleapis. Every Google error becomes one of ours:
//   GOOGLE_RECONNECT (409, reconnect) — the grant was revoked or expired: connect again
//   GOOGLE_SCOPE (409) — the member did not give this feature's access
//   GOOGLE_NOT_FOUND (404) — e.g. a stale Gmail historyId (HISTORY_GONE: sync everything again)
//   GOOGLE_DUPLICATE (409) — an event with this id is there already (a retried insert)
//   GOOGLE_FAILED (502, retry) — anything else
const SCOPES = Object.freeze({
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  drive: 'https://www.googleapis.com/auth/drive.file',
});

function oauth(creds = {}) {
  const auth = new google.auth.OAuth2(env.googleClientId, env.googleClientSecret, env.googleRedirectUri);
  if (creds.accessToken || creds.refreshToken) auth.setCredentials({ access_token: creds.accessToken, refresh_token: creds.refreshToken, expiry_date: creds.expiryDate });
  return auth;
}

function failure(error) {
  const status = error.response?.status || (typeof error.code === 'number' ? error.code : 0);
  const reason = error.response?.data?.error;
  if (reason === 'invalid_grant' || status === 401) return Object.assign(new Error('Google stopped accepting the CRM\'s access.'), { statusCode: 409, code: 'GOOGLE_RECONNECT', reconnect: true });
  if (status === 403 && /insufficient|scope|permission/i.test(JSON.stringify(error.response?.data || error.message))) {
    return Object.assign(new Error('This Google feature was not allowed when connecting.'), { statusCode: 409, code: 'GOOGLE_SCOPE' });
  }
  if (status === 404) return Object.assign(new Error('Not found at Google.'), { statusCode: 404, code: 'GOOGLE_NOT_FOUND' });
  if (status === 409) return Object.assign(new Error('It is at Google already.'), { statusCode: 409, code: 'GOOGLE_DUPLICATE' });
  return Object.assign(new Error(`Google did not answer: ${error.message}`), { statusCode: 502, code: 'GOOGLE_FAILED', retry: true });
}
const call = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    throw failure(error);
  }
};

function authorizeUrl({ state, scopes, loginHint }) {
  return oauth().generateAuthUrl({ access_type: 'offline', prompt: 'consent', include_granted_scopes: true, scope: scopes, state, ...(loginHint && { login_hint: loginHint }) });
}

async function exchangeCode({ code }) {
  const { tokens } = await call(() => oauth().getToken(code));
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiryDate: tokens.expiry_date || Date.now() + 3600 * 1000, scopes: String(tokens.scope || '').split(' ').filter(Boolean) };
}

async function refresh({ refreshToken }) {
  const auth = oauth({ refreshToken });
  const { credentials } = await call(() => auth.refreshAccessToken());
  return { accessToken: credentials.access_token, refreshToken: credentials.refresh_token || null, expiryDate: credentials.expiry_date || Date.now() + 3600 * 1000 };
}

const gmail = (creds) => google.gmail({ version: 'v1', auth: oauth(creds) });

async function profile(creds) {
  const { data } = await call(() => gmail(creds).users.getProfile({ userId: 'me' }));
  return { emailAddress: data.emailAddress, historyId: String(data.historyId || ''), messagesTotal: data.messagesTotal || 0 };
}

async function listMessages(creds, { q = '', pageToken, maxResults = 100 } = {}) {
  const { data } = await call(() => gmail(creds).users.messages.list({ userId: 'me', q, maxResults, ...(pageToken && { pageToken }) }));
  return { messages: (data.messages || []).map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: data.nextPageToken || null };
}

async function getMessage(creds, id) {
  const { data } = await call(() => gmail(creds).users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] }));
  const headers = Object.fromEntries((data.payload?.headers || []).map(({ name, value }) => [name.toLowerCase(), value]));
  return { id: data.id, threadId: data.threadId, historyId: String(data.historyId || ''), internalDate: Number(data.internalDate) || null, snippet: data.snippet || '', headers };
}

// The ids of messages added since startHistoryId. A stale id is HISTORY_GONE.
async function history(creds, { startHistoryId, pageToken }) {
  try {
    const { data } = await call(() => gmail(creds).users.history.list({ userId: 'me', startHistoryId, historyTypes: ['messageAdded'], ...(pageToken && { pageToken }) }));
    const ids = (data.history || []).flatMap((h) => (h.messagesAdded || []).map((m) => m.message?.id)).filter(Boolean);
    return { messageIds: [...new Set(ids)], historyId: String(data.historyId || startHistoryId), nextPageToken: data.nextPageToken || null };
  } catch (error) {
    if (error.code === 'GOOGLE_NOT_FOUND') throw Object.assign(error, { code: 'HISTORY_GONE' });
    throw error;
  }
}

// Calendar (9B): the member's primary calendar.
const calendar = (creds) => google.calendar({ version: 'v3', auth: oauth(creds) });
// event.id is ours (base32hex), so a retried insert answers GOOGLE_DUPLICATE instead of a copy.
async function insertEvent(creds, event) {
  const { data } = await call(() => calendar(creds).events.insert({ calendarId: 'primary', requestBody: event }));
  return { id: data.id, htmlLink: data.htmlLink || '' };
}
async function updateEvent(creds, id, event) {
  const { data } = await call(() => calendar(creds).events.update({ calendarId: 'primary', eventId: id, requestBody: { ...event, status: 'confirmed' } }));
  return { id: data.id, htmlLink: data.htmlLink || '' };
}
async function deleteEvent(creds, id) {
  try {
    await call(() => calendar(creds).events.delete({ calendarId: 'primary', eventId: id }));
  } catch (error) {
    if (error.code !== 'GOOGLE_NOT_FOUND') throw error; // already gone
  }
}

// Drive (9B): a new Doc or Sheet the CRM makes (drive.file reaches only these).
async function createFile(creds, { name, mimeType }) {
  const { data } = await call(() => google.drive({ version: 'v3', auth: oauth(creds) }).files.create({ requestBody: { name, mimeType }, fields: 'id,name,mimeType,webViewLink' }));
  return { id: data.id, name: data.name, mimeType: data.mimeType, webViewLink: data.webViewLink };
}

// Sheets (G4, D108): a spreadsheet the CRM makes (drive.file reaches only its own files) with a
// bold, frozen header row, and new rows at the end of its first tab. Rows go by the tab's id, so
// renaming the tab changes nothing; values go as plain strings and numbers, never as formulas.
const sheets = (creds) => google.sheets({ version: 'v4', auth: oauth(creds) });
const cellOf = (value) => (value === null || value === undefined || value === ''
  ? {}
  : { userEnteredValue: typeof value === 'number' ? { numberValue: value } : { stringValue: String(value) } });

async function createSpreadsheet(creds, { title, sheetTitle, headers }) {
  const { data } = await call(() => sheets(creds).spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [{
        properties: { sheetId: 0, title: sheetTitle, gridProperties: { frozenRowCount: 1 } },
        data: [{ startRow: 0, startColumn: 0, rowData: [{ values: headers.map((header) => ({ ...cellOf(header), userEnteredFormat: { textFormat: { bold: true } } })) }] }],
      }],
    },
    fields: 'spreadsheetId,spreadsheetUrl,sheets.properties.sheetId',
  }));
  return { id: data.spreadsheetId, url: data.spreadsheetUrl, sheetId: data.sheets?.[0]?.properties?.sheetId ?? 0 };
}

// A deleted tab answers 400: like a deleted sheet, there is nowhere to write (GOOGLE_NOT_FOUND).
async function appendRows(creds, { spreadsheetId, sheetId, rows }) {
  try {
    await sheets(creds).spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ appendCells: { sheetId, rows: rows.map((row) => ({ values: row.map(cellOf) })), fields: 'userEnteredValue' } }] },
    });
  } catch (error) {
    if (error.response?.status === 400) throw Object.assign(new Error('The sheet or its first tab is not there any more.'), { statusCode: 404, code: 'GOOGLE_NOT_FOUND' });
    throw failure(error);
  }
  return { added: rows.length };
}

module.exports = { name: 'google', SCOPES, authorizeUrl, exchangeCode, refresh, profile, listMessages, getMessage, history, insertEvent, updateEvent, deleteEvent, createFile, createSpreadsheet, appendRows, failure };
