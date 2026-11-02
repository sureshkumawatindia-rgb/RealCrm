const crypto = require('crypto');
const env = require('../../config/env');
const { SCOPES } = require('./workspace');

// A stand-in for Google (Phase 9, D90) in tests and in development with DEV_TOOLS: a mailbox,
// a calendar and a drive per address, in memory. Its consent page sends the browser straight
// back to the callback, as Google would after the person agrees. Tests drive it with addMessage,
// revoke (the grant is refused from then on) and forgetHistory (the next history call is stale).
const boxes = new Map();
const box = (email) => {
  if (!boxes.has(email)) boxes.set(email, { historyId: 1000, oldestHistoryId: 1000, messages: [], events: new Map(), files: new Map(), sheets: new Map(), revoked: false });
  return boxes.get(email);
};
const emailOf = (creds) => String(creds?.accessToken || creds?.refreshToken || '').split(':')[1] || '';
function guard(creds) {
  const email = emailOf(creds);
  if (!email || box(email).revoked) throw Object.assign(new Error('Google stopped accepting the CRM\'s access.'), { statusCode: 409, code: 'GOOGLE_RECONNECT', reconnect: true });
  return box(email);
}
const tokensFor = (email) => ({ accessToken: `mock-access:${email}:${crypto.randomBytes(4).toString('hex')}`, refreshToken: `mock-refresh:${email}`, expiryDate: Date.now() + 3600 * 1000 });

function authorizeUrl({ state }) {
  const url = new URL(`${env.publicUrl}/api/v1/gmail/mock-consent`);
  url.searchParams.set('state', state);
  return url.toString();
}

// loginHint: the CRM user's address (the stand-in signs them in as themselves).
async function exchangeCode({ code, loginHint }) {
  if (!String(code).startsWith('mock:')) throw Object.assign(new Error('Bad code'), { statusCode: 400, code: 'GOOGLE_FAILED' });
  const b = box(loginHint);
  b.revoked = false;
  return { ...tokensFor(loginHint), scopes: null };
}

async function refresh({ refreshToken }) {
  const email = emailOf({ refreshToken });
  guard({ refreshToken });
  return { ...tokensFor(email), refreshToken: null };
}

async function profile(creds) {
  const b = guard(creds);
  return { emailAddress: emailOf(creds), historyId: String(b.historyId), messagesTotal: b.messages.length };
}

async function listMessages(creds, { pageToken, maxResults = 100 } = {}) {
  const b = guard(creds);
  const sorted = [...b.messages].sort((x, y) => y.internalDate - x.internalDate);
  const start = Number(pageToken) || 0;
  const page = sorted.slice(start, start + maxResults);
  return { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: start + maxResults < sorted.length ? String(start + maxResults) : null };
}

async function getMessage(creds, id) {
  const b = guard(creds);
  const m = b.messages.find((x) => x.id === id);
  if (!m) throw Object.assign(new Error('Not found at Google.'), { statusCode: 404, code: 'GOOGLE_NOT_FOUND' });
  return { id: m.id, threadId: m.threadId, historyId: String(m.historyId), internalDate: m.internalDate, snippet: m.snippet, headers: { from: m.from, to: m.to, cc: m.cc || '', subject: m.subject, date: new Date(m.internalDate).toUTCString() } };
}

async function history(creds, { startHistoryId, pageToken }) {
  const b = guard(creds);
  if (Number(startHistoryId) < b.oldestHistoryId) throw Object.assign(new Error('Not found at Google.'), { statusCode: 404, code: 'HISTORY_GONE' });
  const added = b.messages.filter((m) => m.historyId > Number(startHistoryId)).map((m) => m.id);
  const start = Number(pageToken) || 0;
  return { messageIds: added.slice(start, start + 50), historyId: String(b.historyId), nextPageToken: start + 50 < added.length ? String(start + 50) : null };
}

let failNextCalendar = 0;
async function insertEvent(creds, event) {
  const b = guard(creds);
  const id = event.id || `mockgcal${crypto.randomBytes(5).toString('hex')}`;
  if (b.events.has(id)) throw Object.assign(new Error('It is at Google already.'), { statusCode: 409, code: 'GOOGLE_DUPLICATE' });
  b.events.set(id, { ...event, id });
  if (failNextCalendar > 0) {
    failNextCalendar -= 1; // made at Google, but the answer was lost: the job will retry
    throw Object.assign(new Error('Google did not answer.'), { statusCode: 502, code: 'GOOGLE_FAILED', retry: true });
  }
  return { id, htmlLink: `https://calendar.google.com/mock/${id}` };
}
async function updateEvent(creds, id, event) {
  const b = guard(creds);
  if (!b.events.has(id)) throw Object.assign(new Error('Not found at Google.'), { statusCode: 404, code: 'GOOGLE_NOT_FOUND' });
  b.events.set(id, { ...event, id });
  return { id, htmlLink: `https://calendar.google.com/mock/${id}` };
}
async function deleteEvent(creds, id) {
  guard(creds).events.delete(id);
}

async function createFile(creds, { name, mimeType }) {
  const b = guard(creds);
  const id = `mock-file-${crypto.randomBytes(5).toString('hex')}`;
  const kind = mimeType.endsWith('spreadsheet') ? 'spreadsheets' : 'document';
  const file = { id, name, mimeType, webViewLink: `https://docs.google.com/${kind}/d/${id}/edit` };
  b.files.set(id, file);
  return file;
}

// Sheets (G4): a spreadsheet is its tabs' rows (the header first).
let failNextSheets = 0;
async function createSpreadsheet(creds, { title, sheetTitle, headers }) {
  const b = guard(creds);
  const id = `mock-sheet-${crypto.randomBytes(5).toString('hex')}`;
  const url = `https://docs.google.com/spreadsheets/d/${id}/edit`;
  b.sheets.set(id, { id, title, url, tabs: new Map([[0, { title: sheetTitle, rows: [[...headers]] }]]) });
  return { id, url, sheetId: 0 };
}
async function appendRows(creds, { spreadsheetId, sheetId, rows }) {
  const b = guard(creds);
  const tab = b.sheets.get(spreadsheetId)?.tabs.get(sheetId);
  if (!tab) throw Object.assign(new Error('The sheet or its first tab is not there any more.'), { statusCode: 404, code: 'GOOGLE_NOT_FOUND' });
  if (failNextSheets > 0) {
    failNextSheets -= 1;
    throw Object.assign(new Error('Google did not answer.'), { statusCode: 502, code: 'GOOGLE_FAILED', retry: true });
  }
  tab.rows.push(...rows.map((row) => [...row]));
  return { added: rows.length };
}

// --- for tests and development ---------------------------------------------------------------
function addMessage(email, { from, to, cc = '', subject = '', snippet = '', at = Date.now(), threadId }) {
  const b = box(email);
  b.historyId += 1;
  const id = `mock-msg-${crypto.randomBytes(5).toString('hex')}`;
  b.messages.push({ id, threadId: threadId || `mock-thread-${crypto.randomBytes(4).toString('hex')}`, historyId: b.historyId, internalDate: at, from, to, cc, subject, snippet });
  return id;
}
const revoke = (email) => { box(email).revoked = true; };
// History before now is gone (Google keeps it about a week): the next history call fails.
const forgetHistory = (email) => { const b = box(email); b.oldestHistoryId = b.historyId + 1; };
const events = (email) => [...box(email).events.entries()].map(([id, event]) => ({ id, ...event }));
const files = (email) => [...box(email).files.values()];
// Sheets (G4): a sheet's rows; a sheet deleted at Google; the next append fails.
const sheetRows = (email, id) => box(email).sheets.get(id)?.tabs.get(0)?.rows || [];
const deleteSheet = (email, id) => { box(email).sheets.delete(id); };
const failNextSheetAppend = () => { failNextSheets += 1; };
// The next insert reaches Google but its answer is lost (a retry must not make a copy).
const loseNextInsertAnswer = () => { failNextCalendar += 1; };
const reset = () => { boxes.clear(); failNextCalendar = 0; failNextSheets = 0; };

module.exports = {
  name: 'mock', SCOPES, authorizeUrl, exchangeCode, refresh, profile, listMessages, getMessage, history, insertEvent, updateEvent, deleteEvent, createFile,
  createSpreadsheet, appendRows,
  addMessage, revoke, forgetHistory, events, files, sheetRows, deleteSheet, failNextSheetAppend, loseNextInsertAnswer, reset,
};
