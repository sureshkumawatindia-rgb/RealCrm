/**
 * sw.js — the CRM's service worker (Phase 10E): the app can be installed on a phone, opens
 * offline to a short notice, and shows web push notifications (the bell's notes) even when
 * no CRM tab is open.
 * Pages, scripts and styles come from the network first (always the latest), with the last copy
 * kept for when the network is gone; images from the cache first. The API is never cached:
 * business data stays on the server.
 */
const CACHE = "ycrm-shell-v1";
const OFFLINE_PAGE = "offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([OFFLINE_PAGE, "img/icons/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith("ycrm-") && name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Only this app's own files; the API, uploads and other sites go straight to the network.
  if (request.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  if (/\.(png|jpe?g|svg|webp|ico|woff2?)$/i.test(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
      return response;
    })));
    return;
  }
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(request)) || (request.mode === "navigate" ? caches.match(OFFLINE_PAGE) : Response.error())),
  );
});

// A web push from the CRM: { title, body, url, tag }.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(self.registration.showNotification(data.title || "YELLOW CRM", {
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
