# Phase 6: Every conversation in one place, and calls (spec)

Status: **approved with its defaults by the user's go-ahead of 2026-10-21**; the user said "continue" (start Phase 6) on 2026-10-22. This is Phase 6, "Built-in Communication" (inspired by Freshsales), of `docs/CRM_10_FEATURE_IMPLEMENTATION_PROMPT.md`. **Built on 2026-10-22 (D85);** what was built and the scorecard are in sections 10 and 11.

## 1. Goal

An Indian SMB talks to customers on WhatsApp and the phone, sometimes email. The owner wants:

1. **One history per customer**, newest first: WhatsApp messages, calls, emails, notes, deals and their stage moves, quotations, orders and payments, tickets, tasks and meetings. It should be one scroll, filterable, and fast for a customer with years of history.
2. **Calls in the CRM:**
   - log a call made from one's own mobile in a few taps (what happened, how long, a note);
   - or press **Call**: the CRM rings the salesperson's phone first, then connects the customer, and logs the call by itself (through a cloud-telephony provider);
   - a call counts as activity on the deal, so the board stops calling it "quiet".

## 2. What exists today (from the code)

- **WhatsApp:** `Conversation` and `Message` per contact, the Inbox, a read-only chat panel on Customer 360, and phone masking for agents (`req.maskPhones`).
- **Customer 360 "Timeline" tab:**
  - built in the browser from cached lists: deals, tasks, tickets, documents, notes;
  - **no WhatsApp messages, no quotations or orders, no stage moves, no consent changes;**
  - not paginated (it shows what the browser loaded).
- **Gmail:** each user's mailbox, read-only (`gmail.readonly`); `GET /gmail/messages?q=` searches it. Sending is not possible and is not claimed.
- **Calls:** nothing. There is no Call record, no calling provider, and no dispositions.
- **SMS:** an MSG91 adapter for login codes only.
- **Stage history** (D84), consent events (D79), touchpoints (D79) and quotation/order history exist as records.

## 3. Zoho CRM benchmark (official pages, checked 2026-10-22)

Sources:
- [Zoho CRM – Telephony (PhoneBridge)](https://help.zoho.com/portal/en/kb/crm/extensions/telephony)
- [Zoho CRM – Integrate Knowlarity](https://help.zoho.com/portal/en/kb/crm/extensions/telephony/articles/integrate-with-knowlarity)
- [Zoho Voice – Zoho CRM telephony integration](https://www.zoho.com/voice/help/zoho-crm-telephony-integration.html)
- [Zoho CRM API – Get Timeline of a Record](https://www.zoho.com/crm/developer/docs/api/v8/timeline-of-a-record.html)
- [Zoho community – revamped timeline view](https://help.zoho.com/portal/en-gb/community/topic/zoho-crms-revamped-timeline-view-will-extend-to-3-years-and-support-notes-filters-and-email-statuses)

What Zoho does well:
- **PhoneBridge** connects telephony providers (Knowlarity and others) under Setup → Channels → Telephony.
  - Each call becomes a Call record linked to the matching phone number.
  - Click-to-call, screen pops, and notes in "Call Disposition" (Zoho Voice).
- **The record timeline** goes back 3 years, filters by module, user, time and source, and shows a sent email's status.

Where Zoho is limited:
- **WhatsApp lives elsewhere** (Zoho's WhatsApp is an extension), so a record's timeline is mostly CRM changes.
- **The timeline mixes system entries** (field updates, webhooks) with sales activity. Users have asked for years for "just tasks, events and emails". Received emails are said not to appear (community post: UNVERIFIED).
- **Exotel**, common in India, has no Zoho CRM PhoneBridge page (UNVERIFIED; Zoho lists it for Bigin).

Where AgreemCRM Phase 6 will be better (each point can be checked):
- **One customer history** with WhatsApp in and out, calls, emails from the viewer's own Gmail, notes, deal moves, quotations, orders and payments, tickets, tasks and meetings.
  - Filters: All, Talks (WhatsApp, calls, email), Sales, Service, Notes.
  - Cursor pages ("Load more"), so years of history stay fast.
  - **No system noise** (field edits are not timeline items).
- **Calls logged in ≤ 3 taps** from Customer 360, with an outcome list made for Indian sales teams (interested, call back, not interested, no answer, busy, wrong number, switched off).
- **Click-to-call through Exotel** (the company's own Exotel account), logged by itself. The call status comes back through a webhook that only that company's secret address accepts. **No recordings are stored.**
- **A call is activity:** the lead's last activity moves, so the board's "quiet" flag clears.

Where it will **not** be better yet:
- **No email sending or email tracking:** Gmail is read-only, and sending needs a decision on a provider and scopes.
- **No incoming-call screen pop, IVR or recordings.**
- **No SMS** (only login codes); SMS and the power dialer come in Phase 8.
- **Exotel's status-callback fields are UNVERIFIED** (its public page documents the request and the Call object, not the callback). The webhook reads both shapes and is tested with a mock; the first real call should be checked by hand.

## 4. Scope

1. **`GET /contacts/:id/timeline`**, a merged history of one customer, newest first.
   - `kinds` filter: `talk` (WhatsApp, calls), `sales` (deals, stage moves, quotations, orders, payments), `service` (tickets), `work` (tasks, meetings), `notes`, `other` (enquiries, consent).
   - `before` cursor and `limit` (default 30, at most 100). The answer gives `next` (a cursor) when more exist.
   - **Scoped like the rest of the CRM:**
     - the contact must be visible to the member;
     - WhatsApp only for members who can open the Inbox;
     - deals, quotations and orders follow lead visibility;
     - tasks, meetings and tickets need their modules;
     - phones are masked for agents who see them masked.
2. **Calls (`Call`, per company):**
   - direction (in or out), the contact, optionally a lead, who made or took it, and when;
   - the duration and an **outcome**: `connected`, `interested`, `callback`, `not_interested`, `no_answer`, `busy`, `wrong_number`, `switched_off`;
   - a note, a status (`queued`, `ringing`, `in_progress`, `completed`, `failed`, `busy`, `no_answer`, `cancelled`), how it was made (`manual`, `exotel`, `mock`), and the provider's call id (unique per company and provider).
   - **No recording URL is ever stored.**
   - `POST /calls` logs a call by hand (idempotent with `Idempotency-Key`); `GET /calls` lists them (filters: contact, lead, member, date); `PATCH /calls/:id` sets the outcome and note.
   - A call moves `Lead.lastActivityAt` (when it has a lead) and the contact's `lastContactedAt`.
3. **Click-to-call (`POST /calls/dial`):** through the company's telephony connection.
   - It rings the member's own number first (their verified mobile, else the mobile on their member profile), then connects the customer, shown with the company's caller id.
   - The call is created as `queued`, with the provider's id.
   - Provider adapters: **Exotel** (`/v1/Accounts/{sid}/Calls/connect`, HTTP Basic, `Record=false`) and a **mock** for tests and development.
4. **Status webhook `POST /api/v1/webhooks/calls/:connectionKey`:**
   - the address carries a random 32-byte key per connection (Exotel does not sign callbacks), and a wrong key is 404;
   - the call is found by provider id within that company only;
   - updates are idempotent and never go back (a finished call is not reopened);
   - JSON and form bodies are read; recording fields are ignored.
5. **Settings → Calling** (owners and admins):
   - connect Exotel (account SID, API key, API token, subdomain, caller id); the key and token are stored encrypted and never shown again;
   - test the connection; disconnect;
   - Settings → Connections shows it.
6. **Customer 360:**
   - the Timeline tab uses the server's history, with the filter chips, "Load more", and the viewer's Gmail emails with this customer merged in (read-only, when the viewer connected Gmail);
   - **Log a call** (a short form) and **Call** (click-to-call, when the company has a connection and the member a number).
7. **English and Hindi; phones at 390 px.**

## 5. Data model

```
Call                 organizationId, contactId, leadId?, memberId, direction in|out,
                     status, outcome?, durationSec, startedAt, endedAt?, notes (≤ 2000),
                     provider manual|exotel|mock, providerCallId?, connectionId?,
                     fromNumber, toNumber, error?, idempotencyKey?, createdById
                     unique (organizationId, provider, providerCallId) when providerCallId
                     index (organizationId, contactId, startedAt -1)

TelephonyConnection  organizationId (one per company), provider exotel|mock, accountSid,
                     apiKeyEnc, apiTokenEnc, subdomain (default api.exotel.com), callerId,
                     webhookKey (random, unique), status active|error, lastError, lastCallAt

Contact (+)          lastContactedAt
```

## 6. API

| Method, path | Who | What |
|---|---|---|
| `GET /contacts/:id/timeline?kinds&before&limit` | who can see the contact | `{ items: [{ id, kind, source, at, title, detail, direction?, status?, actor?, link? }], next }` |
| `GET /calls?contactId&leadId&memberId&from&to` | customers module | the calls (agents who see only their own: theirs) |
| `POST /calls` | customers module, edit | log a call |
| `PATCH /calls/:id` | who made it, or managers | outcome and note |
| `POST /calls/dial` | customers module, edit | `{ contactId, leadId? }` → the call (`queued`) |
| `GET/PUT/DELETE /telephony` and `POST /telephony/test` | owners, admins | the company's connection (secrets never returned) |
| `POST /webhooks/calls/:key` | the provider | status updates |

## 7. Edge cases

- **A customer without a phone:** Call is refused (`400 NO_PHONE`). **A member without a number:** `400 MEMBER_NO_PHONE`, with where to add it.
- **The provider refuses or is down:** the call is saved as `failed` with the reason and the answer is 502. Nothing is sent twice (an idempotency key on dial).
- **A webhook for an unknown call id:** 200 and ignored (logged). A duplicate webhook changes nothing. The key of another company finds nothing.
- **Duration from the provider** wins over a hand-typed one; the outcome stays the person's.
- **Opted-out customers** can still be called (consent covers marketing messages). The timeline shows the consent state.
- **Pagination ties:** the cursor is the time plus the id, so items with the same time are never skipped or repeated.

## 8. Acceptance checklist

- [x] The timeline merges all sources in time order, pages with no gaps or repeats, filters by kind, hides WhatsApp from members without the Inbox, follows lead visibility, masks phones for agents, and shows nothing of another company (test).
- [x] Log a call: idempotent; it moves the lead's last activity; the outcome is validated (test).
- [x] Dial with the mock: a queued call; the webhook completes it with the duration; a duplicate or late webhook changes nothing; a wrong key is 404; recording fields are not stored; a provider failure gives a failed call and 502 (test).
- [x] The Exotel adapter sends the documented request (Basic auth, `From`/`To`/`CallerId`/`StatusCallback`, `Record=false`); tested against a fake fetch.
- [x] Telephony secrets are stored encrypted and never returned; only managers manage the connection (test).
- [x] Browser: the Customer 360 timeline with filters and "Load more"; log a call; Call with the mock; Settings → Calling; 390 px; Hindi.

## 9. Scorecard targets

| # | Target | How it is measured |
|---|---|---|
| 1 | One history with ≥ 9 kinds of items, filterable, paged | Test + browser |
| 2 | A call logged in ≤ 3 taps from Customer 360 | Browser count |
| 3 | Click-to-call logs itself with no typing; status by webhook | Mock test + browser |
| 4 | 0 cross-company leaks; phones masked for agents; no recordings stored | Tests |
| 5 | 0 regressions; 390 px; Hindi | Full run + browser |

## 10. What was built (D85), and how it differs from this spec

Built on 2026-10-22 as specified, with these differences:

1. **The webhook key is 32 hex characters** (16 random bytes, 128 bits), not 32 bytes. The status address is sent with each call (`StatusCallback`), so nothing has to be pasted into Exotel.
2. **Settings → Calling shows no webhook address** (see 1). The Exotel fields hide when the test provider is picked; the test provider is offered only in tests and with `DEV_TOOLS`.
3. **A call logged by hand as "no answer", "busy" or "switched off"** is saved with the status "no answer", so it does not count as a talk.
4. **The member's number** is their verified mobile (`User.phoneE164`), else the mobile on their member profile. Without either, Call says where to add it.
5. **Emails** in the history come from the viewer's own Gmail (the 10 newest with this customer) and are merged only into what is already loaded. The server's history does not store them.
6. **"Add what came of it"** shows on a call that has no outcome yet (a click-to-call call), and opens the same picker as "Move to…".
7. **Each history item also has `name`** (the record's own words, e.g. the deal's title), and tasks have `due`. The screen puts a translated label in front ("डील: TMT bars"); `title` stays English for the API.
8. **Phone masking now covers a call's `fromNumber` and `toNumber`** (`utils/phoneMask.js`). Without that, agents with "hide customer numbers" would have seen a call's numbers in full in `GET /calls`. Found while building this; tested.
9. **Settings → Calling checks the form first** (Exotel's SID, key and token, and the number customers see) and says what is missing in plain words.

Files:
- **Backend:**
  - new: `constants/calls.js`, `models/Call.js`, `models/TelephonyConnection.js`, `integrations/telephony/{index,exotel,mock}.js`, `services/callService.js`, `services/telephonyService.js`, `services/timelineService.js`, `routes/calls.js`, `validators/calls.js`;
  - changed: `models/Contact.js` (`lastContactedAt`), `routes/index.js`, `routes/contacts.js` (`GET /:id/timeline`), `routes/webhooks.js` (`POST /calls/:webhookKey`), `services/integrationStatusService.js` (the calling row), `utils/phoneMask.js` (see 8).
- **Frontend:** `js/customer-360.js` (the history, Log a call, Call), `js/settings-calling.js` (new), `Settings.html`, `js/settings-connections.js`, `css/style.css`, and 87 texts (`c360.hist.*`, `call.*`, `tel.*`, `conn.kind.calling`, `conn.group.calling`).
- **Tests:** `calls.test.js` (5); `integrationRegistry.test.js` lists the new kind.

## 11. Scorecard results (measured 2026-10-22)

Measured in the isolated preview (port 3100, an in-memory database, the tests' sign-in, the test calling provider), with one customer, a deal, a task, a logged call and 37 notes.

| # | Target | Result |
|---|---|---|
| 1 | One history with ≥ 9 kinds of items, filterable, paged | **Met.** The history reads 14 kinds (WhatsApp, calls, notes, deals, stage moves, quotations, orders, payments, tickets, tasks, meetings, enquiries, consent, documents) plus the viewer's Gmail. A test history holds 9 kinds at once, pages 3 at a time with no gaps or repeats, and filters by kind. In the browser the chips worked (Talks: the call; Sales: the deal; Tasks and meetings: the task; Service: empty), and "Load more" went from 30 to 39 items with no repeats. |
| 2 | A call logged in ≤ 3 taps from Customer 360 | **Met: 3 taps** ("Log a call", "Call back", "Save the call"); **2** when the call went well, since "Talked" is picked already. The call showed at the top at once ("Call to the customer · Call back"). |
| 3 | Click-to-call logs itself with no typing; status by webhook | **Met.** Call with the test provider: the toast said your phone rings first; the call went from your number to the customer's and showed as "Calling…". The status webhook made it "Done · 2 min" (95 s). The same webhook again and a late "ringing" changed nothing, a wrong key got 404, and the recording link was not stored. "Add what came of it" → Interested in 2 taps. |
| 4 | 0 cross-company leaks; phones masked for agents; no recordings stored | **Met (tests).** Another company gets 404 for the history and for logging a call; an agent without the Inbox sees no WhatsApp, and no one else's deal. With "hide customer numbers" an agent sees a call's numbers masked (fixed here, see 10.8) while the owner sees them. No recording field exists, and a recording link in the webhook is dropped. Exotel's key and token are stored encrypted and never returned. |
| 5 | 0 regressions; 390 px; Hindi | **Met.** Full run: 923 of 924 tests passed. The one failure is outside this phase: `Sales Automation.html` has the user's uncommitted edits (17 Oct) using 75 `auto.*` texts that do not exist yet; the committed copy passes. Customer 360's history and call form, Settings → Calling and Connections at 390 px had no sideways scroll, in Hindi. |
