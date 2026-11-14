# The phone app, part 1 (Phase 7, D119)

Phase 7 of the 100 phases (`HUNDRED_PHASES_PLAN.md`). The CRM installs on a phone like an app,
opens with no network, keeps replies written with no network and sends them — once — when the
network is back, and the Inbox is much faster on a phone's 4G.

## Installing it

Every page links the app's description (`manifest.webmanifest`, or `manifest-hi.webmanifest` when
the person uses Hindi: Hindi shortcut names) and registers the service worker (`sw.js`). The
description opens the installed app at the Inbox, with maskable icons (the logo inside Android's
safe circle) and four shortcuts on a long press of the icon: Inbox, New quotation, Leads, Orders.

- **Android (Chrome), computers (Chrome, Edge):** the language and theme menu (the half-circle
  button at the top) shows **Install the app** when the browser offers it; Chrome may also show
  its own bar at the bottom.
- **iPhone and iPad (Safari):** Safari has no offer of its own; **Install the app** shows the
  steps: Share → Add to Home Screen.

Installing needs https (or this computer: `127.0.0.1` / `localhost`).

## What stays on the phone

**The CRM's own files** (the service worker, `sw.js`). The server writes into the service worker
it serves (`GET /crm/frontend/sw.js`, `backend/src/services/appFilesService.js`) every file of
`crm/frontend` with its revision (a hash of its content) and the files kept from the start: the
Inbox, the dashboard, leads, customers, quotations, orders, tasks, the help centre, the login and
no-network pages with every script, style and image they load, the texts (`i18n/en.json`,
`hi.json`) and the help box (`js/help.js`). A page and its files then open from the phone at once;
a page not kept yet is kept the first time it opens.

Any changed file makes a new service worker (the browser checks on every page it opens). It
downloads only the files that changed, takes over the open pages, and a note at the bottom says
**The CRM has been updated — Refresh**. Nothing is ever kept under an old revision for long: once
the new worker runs, older revisions are deleted. The icons' font (Font Awesome) and Google's
fonts are kept too. The API is never the service worker's.

**The Inbox's last answers** (`js/app.js` `crmDevice`, the browser's IndexedDB `ycrm-device`):
the chat lists (not searches), the counts, each chat, its newest 50 messages and notes, the
customer's details beside it, quick replies, approved templates and the team's names — exactly
as the member saw them (agents see numbers masked, D65). The 8 newest chats' messages are kept a
few seconds after the list loads (only those with something new since their copy, and never with
Data Saver on), so they open at once and can be read with no network.

- Copies belong to the signed-in member in their company (`crm_member` id); another person
  signing in on the same browser never sees them.
- At most 300 answers per member, each under 600 KB, for 14 days; the oldest go first.
- **Signing out deletes all of it.** When a session ends by itself, the copies go and replies
  still waiting stay for the same member's next sign-in.
- The server stays the one true record: a copy is only shown when the network is gone, and the
  newest from the server replaces it as soon as the network is back.

Photos and files in chats are not kept (they show "No internet" with no network).

## With no network

- The top bar shows **Offline** (on a phone, its icon) and the number of replies waiting; a tap
  checks again and says when the copy shown was saved. **Can't reach the CRM** when the phone has
  internet but the CRM does not answer (or answers 502/503/504). It turns into **Back online**
  for a moment when the network returns.
- The Inbox shows the chats saved on the phone; a chat read before shows its messages with
  "No internet: the messages as this phone saved them at 10:42". A chat never saved says so.
- Other pages kept on the phone open; their data says "No internet. Try again when you're back
  online." and loads by itself once the network is back.
- A page never opened on this phone shows the no-network page (`offline.html`), with **Open the
  Inbox**.
- Every error with no network is in the person's language (it used to be "CRM API is unreachable
  at …", for developers).

## Replies with no network (the outbox)

A reply written with no network — text, a file up to 25 MB, a voice note, a quick reply's file —
waits on the phone (`crmOutbox`, in the same IndexedDB store) and shows at the end of its chat
with a clock: "Waiting for the internet — it goes by itself", and **Don't send**.

- When the network is back (the browser says so, or the CRM answers its check: after 5, 10, 20 …
  up to 60 seconds), the replies go in the order they were written, one tab at a time.
- Each reply keeps the `Idempotency-Key` it got when it was written. A reply whose answer was lost
  on the way (the 4G dropped after the server took it) is sent again with the same key and the
  server answers with the first result (`Idempotent-Replayed`): **the customer gets it once**.
- The server busy (5xx), too many requests (429), the same reply still being sent
  (`IDEMPOTENCY_IN_PROGRESS`) or the session being renewed: tried again 10 seconds later.
- The server refused it (for example the customer's 24-hour window closed while it waited):
  it stays in the chat with the reason, **Try again** (a new key) and **Delete**.
- A reply that waited more than a day is not sent by itself (it may no longer fit the chat, and
  the server remembers a reply's key for a day): it shows "it waited more than a day" with
  **Try again** and **Delete**. Replies left waiting for a week by someone who never signed in on
  that browser again are deleted.
- A reply waits until the app opens again if the phone closed it; replies are sent only from an
  open page (never in the background), so the member's sign-in is never used behind their back.
- **Sign out** with replies waiting asks first: "1 reply has not gone yet (no internet). If you
  sign out now, it will be deleted. Sign out anyway?"

Templates, products, forms and payments need the network (they say so).

## Faster on 4G

Measured with `npm run bench:phone` (in `backend/`; Chromium with Chrome's own 4G settings and a
budget phone's speed, the CPU 4× slower; a company with 60 chats; the median of 3 runs):

| Language, network | First open: the chats show | Data, first open | Next open: the chats show | A chat opens |
| --- | --- | --- | --- | --- |
| Hindi, Slow 4G | 17.5 s → **5.8 s** | 2.6 MB → **861 KB** | 3.0 s → **451 ms** | 1.8 s → **247 ms** |
| Hindi, Fast 4G | 8.1 s → **1.3 s** | 2.6 MB → **861 KB** | 4.5 s → **451 ms** | 2.7 s → **248 ms** |
| English, Slow 4G | 12.7 s → **4.0 s** | 2.0 MB → **633 KB** | 4.4 s → **386 ms** | 2.1 s → **206 ms** |
| English, Fast 4G | 3.3 s → **1.2 s** | 2.0 MB → **633 KB** | 2.3 s → **393 ms** | 1.6 s → **202 ms** |

With no network the Inbox used to show "Couldn't load your CRM data: CRM API is unreachable at …" (that reason in English, even on a Hindi page); now it opens with its 30 chats. Before: the committed code of Phase 6 with its old service worker (whose own downloads the test's 4G did not slow, so the real "next open" was slower still); a chat opens: one of the newest, a few seconds after the list.

What made the difference:

- **The logo** every page loads was a 1254-pixel, 837 KB picture shown 40 pixels wide: now
  160 pixels, 28 KB (the original is kept in `docs/brand/logo-original.png`).
- **Compression** (`compression` in `backend/src/app.js`): pages, scripts, styles, texts and the
  API's answers travel as Brotli or gzip — the Hindi texts 110 KB instead of 500. Files and photos
  already compressed, and answers under 1 KB, travel as they are; sign-in answers carry tokens and
  are never compressed (their size can then never give a token away, "BREACH").
- **The texts start at once:** `js/boot.js` (the first script, in the page's `<head>`) starts
  downloading `i18n/*.json` with the page's own files; `app.js` used to ask only once it had loaded.
- **The phone keeps the files** (above): the next opens need no download at all.
- **The Inbox paints from the phone first:** the saved list, counts and a chat's messages show at
  once, and the network's answer replaces them; the list is asked for at once, not after the
  team's names.

The largest part of a first open is now the fonts: Font Awesome's icons (about 150 KB) and
Google's Inter and Noto Sans Devanagari (about 250 KB), each downloaded once.

## Try it on a phone

On the live address (https), on an Android phone in Chrome:

1. Open the CRM and sign in; the half-circle button at the top → **Install the app**.
2. Open **agreem360** from the home screen: it opens at the Inbox. Open two or three chats.
3. Turn on airplane mode and open the app again: the chats show, and the top bar says Offline.
4. Write a reply: it shows "Waiting for the internet". Turn airplane mode off: it goes by itself.

## The company's switch (Phase 8, D120)

Settings → Data & Privacy → **Keep chats on team phones for working without internet** (on by
default). Off: no phone keeps copies of chats (`crmDevice` saves none and reads none), and each
phone deletes the copies it kept the next time it opens a page (`/auth/me` → `deviceCopies`).
Replies written with no network still wait and go (they are the team's own words). After a
customer's data is erased, every phone drops its copies the same way (`/auth/me` →
`copiesClearedAt`), so nothing of that customer stays on a phone.

## Testing

- `backend/src/tests/phoneApp.test.js`: the service worker's file list and revisions (a changed
  file is a new version), compression, the two app descriptions, the logo's size, the no-network
  page in Hindi.
- `backend/e2e/phone.spec.js` (a Pixel 7 in Hindi, the service worker on): installable and the
  files kept; the Inbox with no network (the saved list, a chat read before, one of the newest);
  a reply written offline goes once when the network is back; a reply whose answer was lost goes
  once (the server's copy checked); a reply that waited more than a day is not sent by itself;
  signing out asks about a waiting reply, then leaves nothing.
  The other end-to-end tests run with the service worker off (they test the pages from the server).
- `npm run bench:phone` — the numbers above (`--no-sw`: as before the phone app, `--runs=5`,
  `--waterfall`, `--out=results.json`).

## Notes

- The in-app browser pane of the Claude desktop app cannot register service workers; Chrome,
  Edge, Safari and Playwright's Chromium can.
- Behind a CDN or proxy, `sw.js` must not be cached (the server sends `Cache-Control: no-cache`).
- Pages served without the backend (VS Code's Live Server) get `sw.js` as it is, with no file
  list: pages come from the network first, with the last copy for no network (as before).
