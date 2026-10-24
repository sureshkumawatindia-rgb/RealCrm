const env = require('../../config/env');
const workspace = require('./workspace');
const mock = require('./mock');

// Google Workspace behind one interface (Phase 9, D90).
//   mock — tests always, and development with DEV_TOOLS=on when no client secret is set
//   live — the platform's Google app (GOOGLE_CLIENT_SECRET)
//   off  — neither: connecting Google is not offered
function mode() {
  if (env.isTest) return 'mock';
  if (env.isStaging) return env.devTools ? 'mock' : 'off'; // F2: never real mailboxes from staging
  if (env.googleClientSecret) return 'live';
  if (env.devTools) return 'mock';
  return 'off';
}

function provider() {
  const current = mode();
  if (current === 'live') return workspace;
  if (current === 'mock') return mock;
  return null;
}

module.exports = { mode, provider, mock, SCOPES: workspace.SCOPES };
