# Phase 9: Google Workspace — Gmail, Calendar and Drive (spec)

Status: **approved with its defaults by the user's go-ahead of 2026-10-21** (all questions and defaults through Phase 10); the user said "Phase 9 shuru karo" on 2026-10-23. This is Phase 9, "Google Workspace Integration" (inspired by Copper), of `docs/CRM_10_FEATURE_IMPLEMENTATION_PROMPT.md`. It is built in two parts: **9A** the Google connection and Gmail sync, **9B** Google Calendar and Drive. **9A was built on 2026-10-23 (D90) and 9B the same day (D91)**; see sections 9A, 9B and 10.

## 1. Goal

Most Indian SMB teams live in Gmail and Google Calendar. The CRM should pick up, by itself, the emails each salesperson exchanges with customers and show them on the customer's history (without anyone copying them in). It should put CRM meetings in each person's Google Calendar, and let a deal carry its Google Docs and Sheets. Each member decides what to connect; nothing else is read.

## 2. What exists today (from the code)

- **`GmailConnection`** (one per user):
  - read-only Gmail (`gmail.readonly`), encrypted tokens, a single-use OAuth state (10 minutes);
  - `GET /gmail/messages` reads Gmail live on each request.
  - No disconnect, no "needs reconnect", no sync cursor (a `historyId` is stored but unused).
  - The routes call `googleapis` directly, so they cannot be tested without Google.
- **Customer 360 (D85)** asks the viewer's own Gmail live for emails with the customer; nothing is kept.
- **Microsoft 365 (D83)** already has the pattern to reuse:
  - a live/test/off adapter;
  - one connection per member;
  - `needs_reconnect` with a bell note when the provider refuses the refresh token;
  - one-way calendar push through jobs with retries, with the external id on the event.
- **Documents** are files or web links. Calendar events have `external.microsoft`.
- **The Settings "Email Integration" card** is English-only, older code.

## 3. Benchmark (official pages, checked 2026-10-23)

| What | Zoho CRM | Copper (inspiration) | This CRM after Phase 9 |
|---|---|---|---|
| Gmail | A Gmail add-on to add a sender as a lead or contact; a Gmail API connection to view and send email in the CRM without storing it in Zoho — [Gmail add-on](https://help.zoho.com/portal/en/kb/crm/integrations/google/google-workspace/articles/configure-zoho-crm-for-gmail-add-on), [Gmail API](https://help.zoho.com/portal/en/kb/crm/integrations/google/google-workspace/articles/use-gmail-api) | Emails with contacts logged by themselves (UNVERIFIED: product pages) | **Read-only sync**: only emails with the company's customers are kept (subject, snippet, who, when), on the customer's history; others are never stored |
| Calendar | Two-way sync of appointments, and exporting meetings (time zones must match) — [Google Calendar sync](https://www.zoho.com/googleworkspace/crm/google-calendar.html), [export meetings](https://help.zoho.com/portal/en/kb/crm/integrations/google/google-workspace/articles/export-meetings-google-calendar) | Calendar sync (UNVERIFIED) | **CRM → Google**, one way, like Outlook (D83); the time zone is sent with each event |
| Drive | Attach Drive files from a record's Attachments: at most 5 files and 5 MB at a time — [attach from Drive](https://help.zoho.com/portal/en/kb/crm/integrations/google/google-workspace/articles/attach-google-drive) | Drive files on records (UNVERIFIED) | **A new Google Doc or Sheet for a deal or customer** in one click (`drive.file`, only files the CRM makes), and pasted Drive links recognised as Google files |
| Incremental sync | — | — | Gmail `history.list` from the last `historyId`; a 404 means a full sync again — [Gmail sync guide](https://developers.google.com/workspace/gmail/api/guides/sync) |

## 4. Scope

### 9A — The Google connection and Gmail sync

1. **One Google connection per member**, extending `GmailConnection`:
   - features: Gmail (always), Calendar and Drive (optional, each adding only its scope: `calendar.events`, `drive.file`, with `include_granted_scopes`);
   - `status` (`active`, `needs_reconnect`), `lastError`;
   - the Gmail sync cursor (`historyId`), `lastSyncAt` and the count;
   - `shareEmails` (default on: the team sees the synced emails' subject and snippet on the customer; off: only the member).
2. **An adapter** `integrations/google` with three modes:
   - **live** (the platform's Google client secret);
   - **mock** (tests, and development with `DEV_TOOLS`): an in-memory mailbox, calendar and drive, with a consent page;
   - **off**.
   The existing routes move onto it, so the Gmail flow can be tested end to end without Google.
3. **API:**
   - `GET /gmail/connection`;
   - `POST /gmail/connect { features: [calendar, drive] }` → the consent address;
   - the callback (single-use state, as today);
   - `PATCH /gmail/connection { shareEmails }`;
   - `DELETE /gmail/connection` (tokens deleted; synced emails stay, as CRM records);
   - `POST /gmail/sync` (now; at most once a minute);
   - `GET /gmail/threads/:threadId` (the synced messages of a thread the viewer may see).
   - `GET /gmail/messages` and `/gmail/profile` keep working.
4. **`EmailMessage`** (per company, one per member's Gmail message, unique `(connectionId, gmailMessageId)`):
   - direction (sent or received), from, to, cc, subject, snippet, when;
   - the matched `contactIds` and their open `leadIds`, `shared`.
   - **Only messages with an address of one of the company's customers are stored**; the rest are counted and dropped.
5. **Sync** (a job every 15 minutes per active connection, and on demand):
   - the first time, the last 30 days (up to 500 messages);
   - then the history since the cursor; a 404 means a full sync of the window again;
   - duplicates are skipped by the unique key;
   - a revoked or expired grant sets `needs_reconnect` with a bell note and stops the job;
   - the customer's "last contacted" and the open deals' last activity move.
6. **History:** emails are a `talk` item on Customer 360 from the server (shared ones, plus the viewer's own private ones), replacing the live Gmail read.
7. **Settings → My profile → Google** (replaces the old Email Integration card):
   - connect or reconnect with the features;
   - the status, the last sync and its count, Sync now, the share switch, disconnect;
   - English and Hindi.

### 9B — Google Calendar and Drive

1. **Calendar** (with the Calendar feature), one way like Outlook:
   - a CRM meeting's owner (its assignee, else its maker) sees it in their primary Google Calendar, for meetings from the day they connected;
   - creating, changing, moving to someone else and deleting in the CRM do the same in Google, through the job queue with retries;
   - `CalendarEvent.external.google { id, memberId, state, error, syncedAt }`;
   - times are sent with the event's time zone (Asia/Kolkata unless set); all-day events as dates.
2. **Drive** (with the Drive feature):
   - `POST /google/drive/files { kind: doc|sheet, name, relatedType, relatedId }` creates the file in the member's Drive (only `drive.file`) and attaches it as a CRM document (a link, with `external.google { fileId, kind }`);
   - a pasted Google Docs, Sheets, Slides or Drive link on any document is recognised (its file id and kind) without calling Google.
3. **Screens:**
   - Customer 360 and the deal box get "New Google Doc" and "New Google Sheet";
   - Google files show their own icon;
   - meetings show their Google sync state like Outlook's.

## 5. Data model

- `GmailConnection` + `memberId`, `features { calendar, drive }`, `status`, `lastError`, `historyId` (now the sync cursor), `lastSyncAt`, `lastSyncCount`, `shareEmails`, `calendarSyncFrom`.
- `EmailMessage { organizationId, connectionId, userId, memberId, gmailMessageId, threadId, direction, from, to[], cc[], subject, snippet, sentAt, contactIds[], leadIds[], shared }`:
  - unique `(connectionId, gmailMessageId)`;
  - indexes `(organizationId, contactIds, sentAt)` and `(organizationId, threadId)`.
- 9B: `CalendarEvent.external.google`, `Document.external.google { fileId, kind }`.

## 6. Edge cases

- A user who is in two companies: the connection belongs to the company where it was made; elsewhere it shows as not connected there.
- An email to two customers is one message with both contacts. An email between teammates only is not stored.
- The same message seen in a full sync and a history sync: stored once.
- The member turns sharing off: their emails, past and future, are hidden from the team.
- Disconnect: the job stops and the tokens are deleted; past emails stay, as CRM records.
- Calendar: a meeting given to someone without Google goes out of the first person's calendar, as Outlook does.
- Drive: no Drive feature → 409 with "connect Google with Drive"; the created file stays in the member's Drive if the CRM document is later deleted.

## 7. Acceptance checklist

- [x] The mock covers the OAuth state (single use, expiry), token refresh, a revoked grant (needs reconnect, a bell note), incremental sync (history), a 404 history (a full sync), duplicates, and tenant isolation (tests).
- [x] Only customers' emails are stored; the team sees shared ones; private ones only their member (test).
- [x] Calendar: create, change, reassign and delete in the CRM reach Google once each (test).
- [x] Drive: a Doc for a deal is created and attached; links are recognised (test).
- [x] Browser: connect Google (mock), sync, emails on Customer 360, a new Google Doc on a deal, at 390 px and in Hindi.

## 8. Scorecard targets

| # | Target | How it is measured |
|---|---|---|
| 1 | A customer's emails on their history with 0 copying, within one sync | Test + browser |
| 2 | 0 duplicate emails across full and incremental syncs; 0 non-customer emails stored | Tests |
| 3 | A revoked Google grant is reported to the member, and nothing breaks | Test |
| 4 | A Google Doc for a deal in ≤ 2 clicks | Browser count |
| 5 | 0 regressions; 0 cross-company leaks; 390 px; Hindi | Full run + tests + browser |

## 9A. What was built in 9A (D90), and how it differs from this spec

Built on 2026-10-23 as specified, with these differences:

1. **The adapter uses the stand-in in every test run** (even with the test client secret), then the live Google app when `GOOGLE_CLIENT_SECRET` is set, then the stand-in with `DEV_TOOLS`, else off. The existing `/gmail/profile` and `/gmail/messages` now go through it too.
2. **A sync job is queued when Google is connected** (every 15 minutes, its first run at once) and stopped on disconnect or a refused grant. Connecting again resumes it. The cursor carries on for the same mailbox in the same company; another mailbox or company starts fresh.
3. **A developer tool** `POST /dev/simulate/gmail` (only with `DEV_TOOLS` and the stand-in) puts an email in one's own stand-in mailbox, for checks in the browser.
4. **Settings → Connections** shows how many teammates connected Google, the latest sync, and how many need to connect again.
5. **Found and fixed while checking:**
   - the call form and the SMS form on Customer 360 (D85, D88), the @ list of the deal box (D87), the bulk bar and the layout buttons of Boards (D87, D89), and the MSG91 field (D88) set their own display, so the `hidden` attribute did not hide them;
   - each now has its own `[hidden]` rule, as the rest of the app does (the call form was showing on Customer 360 before anyone pressed "Log a call").

Files:
- **Backend:**
  - new: `integrations/google/{workspace,mock,index}.js`, `models/EmailMessage.js`, `services/googleService.js`, `services/gmailSyncService.js`, `validators/google.js`;
  - changed: `models/GmailConnection.js`, `models/OAuthState.js` (`features`), `routes/gmail.js`, `routes/dev.js`, `jobs/index.js`, `services/timelineService.js` (emails), `services/integrationStatusService.js`.
- **Frontend:**
  - `js/settings-google.js` (new), `Settings.html`, `js/settings.js` (the old Gmail card's code removed), `js/customer-360.js` (emails from the history), `css/style.css`, `css/boards.css`, `css/deals.css`;
  - 32 texts (`goog.*`, `c360.hist.emailIn`, `c360.hist.emailOut`).
- **Tests:** `google.test.js` (4):
  - the sign-in with features and a single-use, expiring state;
  - full and incremental sync, only customers' emails, a stale history, no duplicates, the thread;
  - sharing, another company, a revoked grant (needs reconnect, a bell note, the job stopped), reconnect, disconnect;
  - the token refresh.

Measured (tests and the isolated preview with the stand-in):
- **Customers' emails on their history with 0 copying:**
  - Settings → Google → tick Calendar and Drive → Connect (the stand-in's consent, back to Settings);
  - two emails with the customer and one personal email in the mailbox; Sync now;
  - "2 new emails with customers"; the personal one was not kept;
  - Customer 360 showed "ग्राहक की ईमेल: Rate for 20 granite slabs?" and "ग्राहक को ईमेल: Re: …" in Hindi at 390 px.
- **0 duplicates, 0 non-customer emails:** a full sync after Google's history ran out found the 3 kept emails and stored none again (test).
- **A revoked grant is reported:** sync answered "connect again", the connection showed it, the member got one bell note, and the job stopped (test).
- **Full run: 970 of 971 tests passed**; the one failure is the user's uncommitted `Sales Automation.html` (75 `auto.*` texts not added yet).

## 9B. What was built in 9B (D91), and how it differs from this spec

Built on 2026-10-23, with these differences:

1. **Google event ids are ours**:
   - `crm<CRM event id><generation>` (Google accepts our own ids);
   - an insert whose answer was lost is retried, finds the event (409) and updates it instead of making a copy;
   - a meeting deleted in Google by hand comes back under the next generation's id (one-way sync), and so does a meeting moved away and back.
2. **The Calendar sync is queued with the Outlook one** on every create, change and delete (a 2-second pause, retries).
   - It uses the Google connection only when Calendar was given; meetings from the day of connecting.
   - An all-day meeting is sent as dates; a timed one with its time zone (Asia/Kolkata unless set), and 30 minutes when it has no end.
3. **Drive files** are made in the member's own Drive and attached as link documents; deleting the CRM document leaves the file.
   - Pasted Google links (Docs, Sheets, Slides, Forms, Drive files and folders) are recognised when a document is saved, and show their kind and icon.
4. **Screens:**
   - Customer 360's Documents tab and the deal box have "New Google Doc" and "New Google Sheet" (shown only when the member gave Drive), and list Google files as links;
   - the deal box asks the server for the deal's documents (that page keeps none);
   - a meeting in the calendar says whether it is in the owner's Google Calendar (also when Microsoft 365 is off).

Files:
- **Backend:**
  - new: `services/googleCalendarService.js`, `services/googleDriveService.js`, `integrations/google/links.js`, `routes/google.js`;
  - changed: `integrations/google/{workspace,mock}.js` (insert/update with our ids; 409 → duplicate), `models/CalendarEvent.js` and `models/Document.js` (`external.google`), `services/eventService.js`, `services/documentService.js`, `routes/index.js`, `jobs/index.js`.
- **Frontend:** `js/app.js` (the shared Google file helpers), `js/customer-360.js`, `js/deals.js`, `js/calendar.js`, `css/style.css`, and 17 texts (`gdrive.*`, `cal.google.*`).
- **Tests:** `googleCalendarDrive.test.js` (3):
  - create, change, reassign out and back, delete;
  - a lost insert answer (no copy); all-day; before the connection day; without Calendar no job;
  - Drive missing, a Doc and a Sheet, pasted links, the Documents permission.

## 10. Scorecard results (measured 2026-10-23)

| # | Target | Result |
|---|---|---|
| 1 | A customer's emails on their history with 0 copying, within one sync | **Met.** After Sync now, Customer 360 showed the email from the customer and the reply, in Hindi at 390 px; the personal email was not kept. |
| 2 | 0 duplicate emails across full and incremental syncs; 0 non-customer emails stored | **Met (tests).** A full sync after a history 404 stored none of the 3 kept emails again. A history sync stored only the new one. Emails with no customer address are counted and dropped. |
| 3 | A revoked Google grant is reported to the member, and nothing breaks | **Met (test).** `needs_reconnect`, one bell note "Connect Google again", the sync job stopped, the rest of the CRM unaffected; connecting again resumes it. |
| 4 | A Google Doc for a deal in ≤ 2 clicks | **Met: 1 click** in the open deal box ("New Google Sheet"/"New Google Doc"); on Customer 360, 2 (the Documents tab, then the button). The file is in the member's Drive and listed as a link. |
| 5 | 0 regressions; 0 cross-company leaks; 390 px; Hindi | **Met.** **Full run: 973 of 974 tests passed**; the one failure is the user's uncommitted `Sales Automation.html` (75 `auto.*` texts not added yet). Tests: another company's customer at the same address sees none of the emails; private emails only to their member; Microsoft 365 sync unchanged. The Google card, Customer 360 emails and documents, and the deal box at 390 px had no sideways scroll, in Hindi. |

**Known limits:**
- Real Google is untested here. Using it needs the platform's Google app with the Gmail read-only, Calendar events and Drive file scopes (`GOOGLE_CLIENT_SECRET` is already in `.env` for Gmail; Google's app verification may be needed for these scopes).
- Calendar is one way (CRM → Google).
- Emails are read, not sent.
