const env = require('../../config/env');
const graph = require('./graph');
const mock = require('./mock');

// Microsoft 365 behind one interface (Phase 4B, D83): authorizeUrl, exchangeCode, refresh, me,
// createEvent, updateEvent, deleteEvent.
//   live  — the platform registered an app (MICROSOFT_CLIENT_ID): the real Microsoft
//   mock  — tests, and development with DEV_TOOLS=on: the stand-in (mock.js)
//   off   — neither: the connection is not offered
function mode() {
  if (env.isStaging) return env.devTools ? 'mock' : 'off'; // F2: never real calendars from staging
  if (env.microsoft.clientId) return 'live';
  if (env.isTest || env.devTools) return 'mock';
  return 'off';
}

function provider() {
  const current = mode();
  if (current === 'live') return graph;
  if (current === 'mock') return mock;
  return null;
}

module.exports = { mode, provider, mock, SCOPES: graph.SCOPES };
