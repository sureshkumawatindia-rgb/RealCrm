/**
 * sw.js — the CRM's service worker. Phase 10E: the app can be installed on a phone and shows web
 * push notifications (the bell's notes) even when no CRM tab is open. Phase 7 (D119,
 * docs/PHONE_APP.md): the CRM's own files stay on the phone, so a page opens at once, also with
 * no network.
 * The server writes BUILD below: every file with its revision (a hash of its content) and the files
 * the phone keeps from the start (the Inbox, the dashboard, the everyday lists, the texts). A file
 * is kept under its revision and comes from the phone; a changed file is a new service worker,
 * which downloads only what changed. Fonts and icons from other sites are kept as well.
 * The API is never kept here: the Inbox's copy for no-network is js/app.js's (crmDevice), cleared
 * at sign-out. Without BUILD (the file served as it is, e.g. by VS Code's Live Server) pages come
 * from the network first, with the last copy for when the network is gone.
 */
const BUILD = /*BUILD*/ null;
const APP = "ycrm-app"; // this app's files, each under its revision
const OTHERS = "ycrm-others"; // fonts and icons from other sites, the live-updates script
const OFFLINE_PAGE = "offline.html";
const SCOPE = new URL(self.registration.scope);
const OLD_CACHES = /^ycrm-shell-v\d+$/; // before Phase 7

const at = (name) => new URL(encodeURI(name), SCOPE).href;
const keyOf = (name, rev) => `${at(name)}?rev=${rev}`;
// Versioned addresses on other sites: a copy never goes out of date.
const FOREVER = [/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome\/[\d.]+\//, /^https:\/\/fonts\.gstatic\.com\//];
// Google's font list (it names the files above): the copy first, renewed in the background.
const RENEWED = [/^https:\/\/fonts\.googleapis\.com\/css2\?/];
const ICONS_CSS = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css";
const ICON_FONTS = ["fa-solid-900.woff2", "fa-regular-400.woff2", "fa-brands-400.woff2"].map((font) => `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/${font}`);
const LIVE_SCRIPT = new URL("/socket.io/socket.io.min.js", SCOPE).href; // Socket.IO's client (the Inbox)

// A file's name in this app ("Inbox.html", "js/app.js"), or null for other addresses.
function nameOf(url) {
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return null;
  try {
    return decodeURIComponent(url.pathname.slice(SCOPE.pathname.length)) || "index.html";
  } catch {
    return null;
  }
}

// Keeps what is not yet on the phone, four files at a time; a file that fails is tried again
// by the next service worker (what arrived stays).
async function keepFiles(names) {
  const cache = await caches.open(APP);
  const queue = names.filter((name) => BUILD.files[name]);
  async function worker() {
    while (queue.length) {
      const name = queue.shift();
      const key = keyOf(name, BUILD.files[name]);
      if (await cache.match(key)) continue;
      const response = await fetch(at(name), { cache: "no-cache" });
      if (!response.ok) throw new Error(`${name}: ${response.status}`);
      await cache.put(key, response);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
}

// The icons' font from its site and the live-updates script, best effort (the pages ask for them
// anyway): an Inbox opened with no network still has its icons and reconnects by itself.
async function keepOthers() {
  const cache = await caches.open(OTHERS);
  await Promise.all([ICONS_CSS, ...ICON_FONTS, LIVE_SCRIPT].map(async (url) => {
    if (await cache.match(url)) return;
    const response = await fetch(url, url === LIVE_SCRIPT ? {} : { mode: "cors", credentials: "omit" });
    if (response.ok) await cache.put(url, response);
  }).map((keeping) => keeping.catch(() => {})));
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(BUILD
    ? Promise.all([keepFiles(BUILD.precache), keepOthers()])
    : caches.open(APP).then((cache) => cache.addAll([OFFLINE_PAGE, "img/icons/icon-192.png"])));
});

// The new files are in: older revisions and the old caches go; this worker takes the open pages.
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter((name) => OLD_CACHES.test(name)).map((name) => caches.delete(name)));
    if (BUILD) {
      const cache = await caches.open(APP);
      const current = new Set(Object.entries(BUILD.files).map(([name, rev]) => keyOf(name, rev)));
      await Promise.all((await cache.keys()).filter((request) => !current.has(request.url)).map((request) => cache.delete(request)));
    }
    await self.clients.claim();
  })());
});

// A page asks whether its files are on the phone (data-app-ready, js/app.js).
self.addEventListener("message", (event) => {
  if (event.data?.type === "ycrm:state") event.source?.postMessage({ type: "ycrm:state", version: BUILD?.version || null, kept: Boolean(BUILD) });
});

// The newest copy of a file in any revision (when the network is gone and this one is not kept).
async function anyCopy(name) {
  const cache = await caches.open(APP);
  const prefix = `${at(name)}?rev=`;
  const keys = (await cache.keys()).filter((request) => request.url.startsWith(prefix));
  return keys.length ? cache.match(keys[keys.length - 1]) : cache.match(at(name));
}

async function offlinePage() {
  return (BUILD && (await caches.match(keyOf(OFFLINE_PAGE, BUILD.files[OFFLINE_PAGE])))) || (await anyCopy(OFFLINE_PAGE)) || Response.error();
}

// One of this app's files: from the phone under its revision, else from the network (and kept).
async function appFile(event, name) {
  const request = event.request;
  const rev = BUILD?.files[name];
  const cache = await caches.open(APP);
  if (rev) {
    const kept = await cache.match(keyOf(name, rev));
    if (kept) return kept;
  }
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic" && !response.redirected) {
      // Without BUILD: kept under its own address (the old way, Phase 10E). A copy that could not
      // be kept is only fetched again next time.
      event.waitUntil(cache.put(rev ? keyOf(name, rev) : at(name), response.clone()).catch(() => {}));
    }
    return response;
  } catch (error) {
    const older = await anyCopy(name);
    if (older) return older;
    if (request.mode === "navigate") return offlinePage();
    throw error;
  }
}

// Other sites' fonts and icons, and the live-updates script: the copy first; renew: fetched again
// in the background each time. An answer the worker cannot read (another site's stylesheet) is
// kept only where it is renewed, so a bad one never stays.
async function copyFirst(event, { renew }) {
  const request = event.request;
  const cache = await caches.open(OTHERS);
  const kept = await cache.match(request);
  if (kept && !renew) return kept;
  const fresh = fetch(request).then(async (response) => {
    if (response.ok || (renew && response.type === "opaque")) await cache.put(request, response.clone()).catch(() => {});
    return response;
  });
  if (!kept) return fresh;
  event.waitUntil(fresh.catch(() => {}));
  return kept;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const name = nameOf(url);
  if (name !== null) {
    if (name !== "sw.js") event.respondWith(appFile(event, name));
    return;
  }
  // The live-updates script (Socket.IO's client): so the Inbox reconnects by itself after
  // opening with no network.
  if (url.href === LIVE_SCRIPT) {
    event.respondWith(copyFirst(event, { renew: true }));
    return;
  }
  if (FOREVER.some((pattern) => pattern.test(url.href))) {
    event.respondWith(copyFirst(event, { renew: false }));
    return;
  }
  if (RENEWED.some((pattern) => pattern.test(url.href))) event.respondWith(copyFirst(event, { renew: true }));
  // Everything else — the API, uploads, quotation links, other sites — straight to the network.
});

// A web push from the CRM: { title, body, url, tag }.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(self.registration.showNotification(data.title || "agreem360", {
    body: data.body || "",
    icon: "img/icons/icon-192.png",
    badge: "img/icons/icon-192.png",
    tag: data.tag || undefined,
    data: { url: data.url || "dashboard.html" },
  }));
});

// Tapping it opens (or focuses) the CRM at the note's page.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "dashboard.html", self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const open = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (open) return open.navigate(target).then((client) => (client || open).focus());
    return self.clients.openWindow(target);
  }));
});
