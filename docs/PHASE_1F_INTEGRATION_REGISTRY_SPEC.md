# Phase 1F: Integration and webhook registry (spec)

Status: **approved 2026-10-21 with the three defaults, and built the same day (not committed)**. What was built and how it differs from this spec is in sections 14 and 15. This is sub-phase 1F ("integration/webhook registry"), the last part of "Deep Customization" in `docs/CRM_10_FEATURE_IMPLEMENTATION_PROMPT.md`. It builds on 1A–1E (D73–D77) and on the public API and webhooks of Phase 10C (`docs/INTEGRATIONS.md`).

## 1. Goal

A company's other tools (its accounts software, Zapier, Make, its own website) should be able to see everything the CRM now holds, safely, and the owner should see at a glance that every connection is healthy:

1. **The company's own data travels too.** Records of its own objects (Machines, Sites …, D75) and quotation approvals (D77) are in the API and in webhooks, like customers and leads already are.
2. **Safer webhooks.** A signature that also covers the time, so an old message cannot be replayed. A new secret that does not break the receiver while it is being updated.
3. **One place for all connections.** WhatsApp, Gmail, payments, lead sources, the Meta Conversions API, API keys and webhooks, each with its state, last activity and last problem.

## 2. What exists today (from the code)

- **Public API** (`routes/publicApi.js`, API keys made by owners and admins, Growth plan and up). Scopes: customers read/write, leads read/write, quotations read, orders read, products read, WhatsApp templates send (`constants/api.js`). It reads and filters custom fields (D74), and writes them on customers. **It has no records of the company's own objects** (D75 left this "not yet").
- **Outbound webhooks** (`services/outboundWebhookService.js`, up to 20 per company), already strong:
  - **Signing:** `X-CRM-Signature: sha256=<HMAC of the raw body>`; `X-CRM-Event-Id` is the same on every attempt.
  - **Addresses:** public https only.
  - **Retries:** 8 attempts over about 45 hours; switched off after 25 failures in a row, and owners and admins are told.
  - **Tools:** a 30-day delivery log with "Send again", and a test ping.
  - **Gaps:** "New secret" replaces the secret **at once**, and the signature does not include the time.
- **Events** (8): lead created / stage changed, customer created, WhatsApp message received, quotation status changed, order created / stage changed, payment received. **Nothing** for records, customer changes or approvals.
- **Connections** each keep their own state, on different Settings tabs:
  - WhatsApp numbers (`WhatsAppAccount.status`, `lastWebhookAt`);
  - payment gateways (`PaymentConnection.status`, `lastWebhookAt`);
  - lead sources (`LeadSourceConnection.status`, `lastLeadAt`, `lastError`);
  - the Meta Conversions API (`ConversionsApiConnection.status`, `lastError`);
  - API keys (`lastUsedAt`, `revokedAt`);
  - webhooks (`lastStatus`, `failuresInARow`, `active`);
  - Gmail (Your Profile).

  **There is no single overview.**

## 3. Zoho CRM benchmark (official pages, checked 2026-10-21)

Sources:
- [Zoho Developer – Create Webhooks](https://www.zoho.com/developer/help/extensions/automation/webhooks.html) (an extensions help page; it may describe an older setup, so the webhook figures below are UNVERIFIED for today's CRM)
- [Zoho CRM API v8 – Limits](https://www.zoho.com/crm/developer/docs/api/v8/api-limits.html)

What Zoho does well:
- **A large API** with credits per 24 hours by edition:
  - Free: 5,000;
  - Standard: 50,000 + 250 per user, up to 100,000;
  - Professional: 50,000 + 500 per user, up to 3,000,000;
  - Enterprise: 50,000 + 1,000 per user, up to 5,000,000;
  - Ultimate: 50,000 + 2,000 per user, no cap.

  Concurrency is 5 to 25 calls at a time. It also has GraphQL, bulk APIs, a marketplace, and OAuth for third-party apps.
- **Webhooks from workflow rules** (instant or time-based).

Where Zoho is limited (per the webhooks page, UNVERIFIED for today):
- Up to 6 webhooks per workflow rule, and **at most 10 CRM fields** per webhook.
- **No built-in signature**: authentication is done by adding custom parameters such as tokens.
- **One retry**, 15 minutes later, then nothing; there is a daily cap whose number is not given.

Where AgreemCRM 1F will be better (each point can be checked):
- **Every webhook is signed,** with the time in the signature (replay protection). A secret can be renewed with **24 hours** in which both work.
- **The whole record,** with all its custom fields, in every webhook; **8 attempts** with a delivery log and "Send again".
- **One screen** showing every connection's health, with what to fix.

Where it will **not** be better:
- No GraphQL, bulk API, marketplace or OAuth for third-party apps.
- The API stays on the Growth plan and up (D69).

## 4. Scope

In 1F:

1. **Records in the public API**, with new scopes `records:read` and `records:write`:
   - `GET /public/v1/objects` lists the company's objects and their fields;
   - `GET /public/v1/records?object=` and `GET /public/v1/records/:id` (search, `cf=` filters, pages);
   - `POST /public/v1/records` and `PATCH /public/v1/records/:id`.

   Values use the API's shape: a dropdown by its choice's name (D74), and a link field as the record id.
2. **New webhook events:**
   - `record.created`, `record.updated`, `record.deleted`;
   - `contact.updated`;
   - `quotation.approval_requested`, `quotation.approval_decided`.

   Each sends the whole record in the API's shape. Payloads of existing events do not change.
3. **Signature with time:** every delivery also gets `X-CRM-Timestamp` (Unix seconds) and `X-CRM-Signature-256: t=<timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`. The old `X-CRM-Signature` stays, so receivers that exist today keep working. The docs tell receivers to refuse a timestamp older than 5 minutes.
4. **"New secret" with 24 hours of overlap:**
   - The old secret keeps working for 24 hours: during that time `X-CRM-Signature-256` carries two `v1=` values (new and old).
   - "End the overlap now" drops the old secret at once.
   - The old `X-CRM-Signature` uses the new secret, as today.
5. **Settings → Connections:** one list of every integration the company has:
   - WhatsApp numbers, Gmail, payment gateways, lead sources, Meta Conversions API, API keys and webhooks;
   - each with its state (Working / Needs attention / Off), last activity, last problem in plain words, and a button to its own settings;
   - a count "2 need attention" on the tab.
6. **Event catalogue:** in Settings → API & webhooks, each event shows a sample payload with a Copy button, for Zapier and Make.
7. **English and Hindi** for every new screen text; phones at 390 px.

Not in 1F: OAuth apps, a marketplace, GraphQL or bulk APIs, incoming webhooks for custom objects, a Zapier/Make app listing.

## 5. Data model

All additive, no migration:
- **`WebhookSubscription`**: `previousSecretEnc` and `previousSecretUntil` for the overlap.
- **`constants/api.js`**:
  - scopes `records:read` and `records:write`;
  - the six new events and their labels;
  - a sample payload per event (used by the catalogue and by tests).
- **Connections overview:** no new collection; it reads the existing state fields.

## 6. API

| Method and path | Who | What |
|---|---|---|
| `GET /public/v1/objects` | API key with `records:read` | `[{ key, singular, plural, fields: [{ key, label, type, options, lookupTarget }] }]`, active only |
| `GET /public/v1/records?object=&search=&cf=&page=&limit=` | `records:read` | the object's records, newest first |
| `GET /public/v1/records/:id` | `records:read` | one record: `{ id, object, name, contactId, ownerId, customFields, createdAt, updatedAt }` |
| `POST /public/v1/records`, `PATCH /public/v1/records/:id` | `records:write` | `{ object, name, contactId?, customFields? }`, checked like the CRM's own form, but never stopped by a required field (D73) |
| webhooks | as today | the six new events; `X-CRM-Timestamp` and `X-CRM-Signature-256` on every delivery |
| `POST /outbound-webhooks/:id/rotate-secret` (exists) | owner, admin | also `{ overlapHours: 24 \| 0 }`; default 24 |
| `POST /outbound-webhooks/:id/end-overlap` | owner, admin | drops the old secret now |
| `GET /outbound-webhooks` (exists; it lists the events too) | owner, admin | each event also has `example` |
| `GET /integrations/status` | owner, admin | `[{ kind, id, name, state, lastActivityAt, problem, settingsUrl }]` plus `needsAttention` |

The new API answers use the existing shape and error codes. Every query is scoped to the API key's company. Writes are audited (`record.*` with "via API key"), and so are secret changes (`webhook.secret_rotated`, `webhook.overlap_ended`).

## 7. Screens

- **Settings → Connections** (new tab, owners and admins):
  - one card per connection: icon, name, a coloured state, "Last: 5 min ago", the problem in plain words (for example "Facebook token expired, reconnect"), and **Open settings**;
  - grouped as Messaging, Leads, Payments, Developer.
- **Settings → API & webhooks:**
  - the event list shows **Example** for each event, with Copy;
  - "New secret" says "The old secret keeps working for 24 hours" and offers **End the overlap now**;
  - new API keys can choose the two record scopes.
- **`docs/INTEGRATIONS.md`:** records, the new events, the new signature with code to check it, and the overlap.

## 8. Edge cases

- **An archived object** is not listed; its records cannot be read or written through the API (404), as in the CRM.
- **Links:**
  - a link field takes the linked record's id, which must belong to the same company and the right object;
  - otherwise the API answers 400 `INVALID_LINK`;
  - a key never sees another company's ids.
- **Hidden fields (D77) do not limit the API:** API keys are made by owners and admins, so the API sees what they see. Webhooks go to the company's own systems and carry every field.
- **`record.updated`** is sent only when something changed.
- **Many changes at once** (an import) send one event per record, through the same queue and retries as today.
- **Rotating again during an overlap** keeps only the newest and the one before it.
- **Clock differences:** the receiver is told to allow 5 minutes. The timestamp is the time of each attempt, so a retry is fresh.
- **Connections:**
  - a connection that was never set up is listed as "Not connected" with a "Set up" button, not as a problem;
  - Gmail is per person, so the overview shows how many teammates connected it, not their mailboxes.
- **Another company** never appears in any list, event or status.

## 9. Files

New:
- **Backend:**
  - `services/integrationStatusService.js`
  - `tests/integrationRegistry.test.js`
  - `tests/publicApiRecords.test.js`
- **Frontend:** `js/settings-connections.js`

Changed:
- **Backend:**
  - `constants/api.js`, `models/WebhookSubscription.js`
  - `services/outboundWebhookService.js` (signature, overlap, new events and their data), `services/publicApiService.js`, `routes/publicApi.js`
  - routes and validators: `routes/integrations.js` (`GET /integrations/status`, end overlap), `routes/index.js`, `validators/integrations.js`
  - where events start: `services/customRecordService.js`, `services/contactService.js`, `services/quotationService.js`
- **Frontend:**
  - `Settings.html`, `js/settings-integrations.js`, `css/style.css`
  - `i18n/en.json`, `i18n/hi.json` (new keys only)
- **Docs:** `docs/INTEGRATIONS.md`, `docs/BIZNUMA_ROADMAP.md` (D78)

No new npm packages, no `.env` changes, no data migration.

## 10. Acceptance checklist

- [ ] An API key with `records:read` lists objects and reads records; without it, 403. With `records:write` it adds and changes records, values are checked, and links stay within the company.
- [ ] The six new events are delivered with the whole record, signed with `X-CRM-Signature-256` (time included) and the old header. A receiver following the docs refuses a replay older than 5 minutes.
- [ ] After "New secret", deliveries for 24 hours check with either secret. After "End the overlap now", only the new one works.
- [ ] Settings → Connections shows every connection with the right state; a failing webhook, an expired lead source or an errored Meta connection shows as "Needs attention" with its problem.
- [ ] Another company cannot read or receive any of it.
- [ ] The full test suite has no new failures; every new text is in English and Hindi; checked in the browser on desktop and at 390 px.

## 11. Scorecard targets (goals, not results)

1. **Setup speed:** add a webhook for `record.created` and get a signed test in **6 clicks or fewer** from Settings.
2. **One screen:** all **7 kinds** of connection on Settings → Connections, with their state, measured in the browser.
3. **Safety:** tests prove that a replayed delivery (timestamp older than 5 minutes) fails the documented check, and that both secrets check during the overlap. **0** deliveries are unsigned.
4. **No regressions:** no new failures compared to the last commit run on its own.
5. **Mobile:** Connections and the webhook screens at 390 px with no sideways scroll.

## 12. Decisions for you (defaults in bold)

1. **All of 1F in one go** (API for records, new events, signature with time, overlap, Connections screen), or the API and events first and the rest as a second step.
2. After "New secret", **the old secret keeps working for 24 hours**, or it stops at once (as today).
3. Records in the API: **read and write**, or read only for now.

## 13. Test baseline

1E is built but not committed. In the working folder, **845 tests, 844 passed**; the one failure is the known Sales Automation text keys from your uncommitted Hindi work. If you commit 1E first, 1F starts from that commit.

## 14. What was built, and how it differs from this spec

Built as specified, with these differences:

1. **The API's real path is `/api/public/v1/…`**, like the rest of the public API; this spec wrote `/public/v1/…` for short. Records made through the API belong to the person who made the key.
2. **When `contact.updated` is sent.** It goes out for changes made on the customer itself (the customer form, Customer 360, the API), and only when something changed. It is **not** sent for a change saved inside a lead's form, because that save is part of a larger transaction and the event would go out even if it were undone. As before for `contact.created`, the CSV import sends no events.
3. **Approval events carry the approval as it was when it happened.** The tests showed that by the time a delivery is built, the quotation may already be decided, so `approval_requested` would have said "approved". The event now carries its own copy.
4. **A fix to webhooks found on the way.** The database dropped empty objects from stored deliveries, so a customer without custom values arrived without a `customFields` key. Deliveries are now stored as built (`WebhookDelivery` with `minimize: false`), so the key is always there, as the docs and the examples show.
5. **Event list in Settings.** It now shows each event's meaning next to its name; the hand-written list of eight events was removed, because it would not grow with the new ones. The examples live in `constants/webhookExamples.js`. The tests compare their keys with real deliveries for `contact.updated` and for the approval's `quotation` and `approval`.
6. **The Connections screen:**
   - Gmail shows how many teammates connected it.
   - A lead source shows "Needs attention" when its last error is newer than its last lead.
   - A webhook switched off by the CRM after failures shows "Needs attention"; one switched off by hand shows "Off".
7. **Language.** The new texts on Settings → API & webhooks are in English and Hindi; that page's older texts are still English only, as before (the Hindi rounds will cover them).
8. **One existing test changed on purpose.** `tests/publicApi.test.js` counted 8 scopes; it now counts 10.

Changed files beyond section 9:
- `constants/webhookExamples.js` (new), `models/WebhookDelivery.js`
- `services/approvalService.js` (`publicApproval`, the approval's shape in webhooks)
- `js/settings-connections.js` (new)
- `docs/INTEGRATIONS.md`

## 15. Scorecard results (measured 2026-10-21)

Measured in the isolated preview (port 3100, an in-memory database, the tests' sign-in); the real database was not used.

| # | Target | Result |
|---|---|---|
| 1 | A webhook for `record.created` and a signed test in ≤ 6 clicks | **Met: 6 clicks.** API & webhooks tab, Add a webhook, tick `record.created`, untick `lead.created`, Save; then "Send a test" is the 6th. The test was **not pressed** in the preview: there was no server of ours to receive it, and pressing it would have called a real outside address. Signed deliveries are proven by `tests/integrationRegistry.test.js`. |
| 2 | All 7 kinds on one screen | **Met.** WhatsApp, Gmail, Lead source, Meta Conversions API, Payment gateway, API keys and Webhook, each with its state and a working "Open settings" / "Set up" button. |
| 3 | Replays refused; both secrets work during the overlap; 0 unsigned | **Met.** The tests check that a delivery 6 minutes old, or with a changed body, fails the documented check. Both secrets pass during the overlap; only the new one passes after it ends or after "End the overlap now". Every delivery and the test ping go through the same signing. |
| 4 | No new failures | **Met.** Full run in the working folder: **862 tests, 860 passed**, including 14 new ones (`integrationRegistry.test.js` 9, `publicApiRecords.test.js` 5). The two failures are the known Sales Automation text keys (your uncommitted Hindi work) and the Inbox live-update timing test, which passed alone (12 of 12). |
| 5 | Mobile at 390 px | **Met.** Connections and API & webhooks with no sideways scroll (page width 390 px). On phones the card's button goes under its name. Checked in Hindi too. |
