const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * The phone app's files (Phase 7, D119; docs/PHONE_APP.md). The service worker (crm/frontend/sw.js)
 * keeps the CRM's own files on the phone, each under its revision (a hash of its content): a page
 * opens from the phone at once, with or without the network, and a file is downloaded again only
 * when it changed. The server writes the list into the service worker it serves, so any change to
 * a file is a new service worker, which the browser notices on the next page it opens.
 * Business data is never in this list: the API is not the service worker's (js/app.js keeps the
 * Inbox's copy for no-network, Phase 7).
 */
const FRONTEND_DIR = path.resolve(__dirname, '..', '..', '..', 'crm', 'frontend');
const SERVICE_WORKER = 'sw.js';
const MARKER = '/*BUILD*/ null';
// The files a browser asks for (pages, scripts, styles, texts, images, fonts).
const SERVED = /\.(html|js|css|json|webmanifest|png|jpe?g|svg|webp|ico|woff2?)$/i;
// The pages the phone keeps from the start, with every file they load: the Inbox (the app opens
// there), the dashboard and the everyday lists. Any other page is kept the first time it is opened.
const CORE_PAGES = ['Inbox.html', 'dashboard.html', 'leads.html', 'customers.html', 'Quotations.html', 'Orders.html', 'Tasks.html', 'help.html', 'login.html', 'offline.html'];
// Loaded by a script, not named in a page: the texts, the help box (js/help.js), the app's
// description and small icon (the browser fetches the large icons itself, once, to install).
const CORE_EXTRA = ['i18n/en.json', 'i18n/hi.json', 'js/help.js', 'manifest.webmanifest', 'manifest-hi.webmanifest', 'img/icons/icon-192.png'];

const memo = new Map(); // file → { mtimeMs, size, rev }: a file is read again only when it changed

function filesOf(dir, prefix = '') {
  const names = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...filesOf(dir, name));
    else if (SERVED.test(entry.name) && name !== SERVICE_WORKER) names.push(name);
  }
  return names;
}

function revisionOf(dir, name) {
  const file = path.join(dir, name);
  const { mtimeMs, size } = fs.statSync(file);
  const key = `${dir}|${name}`;
  const known = memo.get(key);
  if (known && known.mtimeMs === mtimeMs && known.size === size) return known.rev;
  const rev = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  memo.set(key, { mtimeMs, size, rev });
  return rev;
}

// The CRM's own files a page names: scripts, stylesheets, icons and images (not other sites').
function localFilesOf(dir, page) {
  const html = fs.readFileSync(path.join(dir, page), 'utf8');
  const found = [];
  for (const match of html.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
    const ref = match[1].split(/[?#]/)[0].replace(/^\.\//, '');
    if (ref && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref) && SERVED.test(ref) && !ref.endsWith('.html')) found.push(ref);
  }
  return found;
}

// { version, files: { "js/app.js": "<rev>", … }, precache: [ … ] } for the files in dir.
function build(dir = FRONTEND_DIR) {
  const files = {};
  for (const name of filesOf(dir).sort()) files[name] = revisionOf(dir, name);
  const precache = new Set();
  for (const page of CORE_PAGES) {
    if (!files[page]) continue;
    precache.add(page);
    localFilesOf(dir, page).forEach((name) => precache.add(name));
  }
  CORE_EXTRA.forEach((name) => precache.add(name));
  const version = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12);
  return { version, files, precache: [...precache].filter((name) => files[name]).sort() };
}

// The service worker with its list of files in it (js: the file as it is, served without the
// backend, e.g. by VS Code's Live Server, works the old way: from the network, the last copy offline).
function serviceWorker(dir = FRONTEND_DIR) {
  const source = fs.readFileSync(path.join(dir, SERVICE_WORKER), 'utf8');
  if (!source.includes(MARKER)) return source;
  return source.replace(MARKER, JSON.stringify(build(dir)));
}

module.exports = { build, serviceWorker, FRONTEND_DIR, CORE_PAGES };
