const fs = require('fs');
const path = require('path');

// Phase 2 acceptance: the pages keep no business data in the browser. Only sign-in details, the
// company profile copy and this browser's page preferences (crm_prefs, e.g. the inbox sound) live
// in localStorage (app.js KEYS), plus three sessionStorage flags around sign-in. Settings → Data &
// Privacy is the one screen that still reads the old browser keys, to move them to the server
// (and to export or clear them).
const FRONTEND = path.resolve(__dirname, '..', '..', '..', 'crm', 'frontend');
const SIGN_IN_KEYS = new Set(['crm_session', 'crm_user', 'crm_member', 'crm_company', 'crm_prefs', 'crm_pending_invite', 'crm_session_expired', 'crm_pending_link']);
const MIGRATION_SCREEN = 'js/settings.js';
const MAY_WRITE_STORAGE = new Set(['js/app.js', 'js/login.js', MIGRATION_SCREEN]);

const files = [
  ...fs.readdirSync(FRONTEND).filter((file) => file.endsWith('.html')),
  ...fs.readdirSync(path.join(FRONTEND, 'js')).filter((file) => file.endsWith('.js')).map((file) => `js/${file}`),
];

describe('Browser storage', () => {
  it.each(files)('%s names no business keys and writes no business data', (file) => {
    const text = fs.readFileSync(path.join(FRONTEND, file), 'utf8');
    const keys = [...text.matchAll(/["'`](crm_[a-z0-9_]+)["'`]/g)].map((match) => match[1]);
    const unexpected = file === MIGRATION_SCREEN ? [] : [...new Set(keys.filter((key) => !SIGN_IN_KEYS.has(key)))];
    expect({ file, unexpected }).toEqual({ file, unexpected: [] });
    if (!MAY_WRITE_STORAGE.has(file)) expect(text).not.toMatch(/localStorage\.setItem/);
  });
});
