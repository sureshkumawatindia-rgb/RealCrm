# Phase 8: Outbound sales — SMS, a power dialer, bulk actions (spec)

Status: **approved with its defaults by the user's go-ahead of 2026-10-21** (all questions and defaults through Phase 10); the user said "Phase 8 shuru karo" on 2026-10-22. This is Phase 8, "Outbound Sales Powerhouse" (inspired by Close), of `docs/CRM_10_FEATURE_IMPLEMENTATION_PROMPT.md`. It is built in two parts: **8A** the SMS channel, **8B** the power dialer and bulk actions. **8A was built on 2026-10-23 (D88)**; see section 9A.

## 1. Goal

A sales team in India works a list: call one customer after another, note what came of each call in a tap, follow up by WhatsApp or SMS, and act on 50 leads at once (give them to someone, move them, add them to a follow-up sequence). A customer who replies or says STOP gets nothing more. A retry never sends twice.

## 2. What exists today (from the code)

- **Calls (D85):** click-to-call through Exotel or the test provider, call outcomes (8 dispositions), `POST /calls` (idempotent), the status webhook.
- **Sequences (D30s, Phase 6B):**
  - steps per day, run as jobs with retries (`seq:<enrollment>:<step>` keys);
  - a log line per step;
  - stop on a WhatsApp reply (`stopOnReply`) and on won or lost; enrolling one customer (`POST /sequences/:id/enroll`, idempotent).
- **Consent:** WhatsApp marketing opt-in or opt-out (`Contact.consent.marketing`, `ConsentEvent`, D79).
- **SMS:** only for login codes (`integrations/sms/msg91.js`, platform keys in `.env`). Customers cannot be sent an SMS.
- **No power dialer, no bulk actions on leads**, and no SMS opt-out.
- **Boards (D87)** list leads with filters: the natural place to pick many.

## 3. Benchmark (official pages, checked 2026-10-22)

| What | Zoho CRM | Close (inspiration) | This CRM after Phase 8 |
|---|---|---|---|
| SMS | No native SMS: through marketplace providers; CRM SMS is meant for one-to-one — [Zoho One channels guide](https://www.zoho.com/one/guides/channels.html) | Built-in SMS (UNVERIFIED: product pages) | **Built in, through the company's own MSG91 account** (DLT-approved templates), one-to-one, in sequences and in bulk with opt-out |
| Power dialer | Through PhoneBridge providers, e.g. Zoho Voice's power dialer on some plans — [Zoho Voice features](https://www.zoho.com/voice/features.html), [PhoneBridge](https://www.zoho.com/phonebridge/telephony-integrations-for-zoho.html) | Power and predictive dialers (UNVERIFIED) | **A power dialer over any list**: the next customer, one press to call, an outcome in one tap, a follow-up date, next. Never dials by itself |
| Dispositions | Call result fields (UNVERIFIED) | Call outcomes | The 8 outcomes of D85, logged on the call |
| Sequences | Cadences (UNVERIFIED: plan and details not checked) | Sequences stop on reply | Existing sequences + **an SMS step**; **stop on a WhatsApp or SMS reply, or an opt-out** |
| Bulk actions | Mass update and mass actions in list views (UNVERIFIED) | Bulk edit, enroll, email | **Bulk** assign, move, follow-up date, tag, add to sequence, send SMS, call in the dialer — each row checked, failures listed |
| Sending SMS (MSG91) | — | — | Flow API `POST https://control.msg91.com/api/v5/flow` with the auth key, `template_id`, `recipients[{ mobiles, VAR… }]` — [MSG91 Flow API](https://control.msg91.com/apidoc/textsms/send-sms-flow.php). The delivery report's shape is UNVERIFIED: read loosely |

## 4. Scope

### 8A — The SMS channel

1. **`SmsConnection`** (one per company, Settings → SMS, owners and admins):
   - provider `msg91` or `mock` (tests and `DEV_TOOLS`);
   - the auth key (encrypted, never shown again) and the sender ID (6 letters, DLT);
   - **templates** (up to 50): a name, MSG91's template (flow) id, the DLT template id, and the approved text with `##var##` blanks;
   - a random **webhook key** for delivery reports and replies.
2. **`SmsMessage`** (per company):
   - the contact, the lead, who or what sent it (`manual`, `sequence`, `workflow`, `bulk`), the template and the filled text, the number;
   - `status`: `queued` → `sent` → `delivered`, or `failed` or `blocked`;
   - the provider's message id (unique per company and provider) and an **idempotency key** (unique per company);
   - the error, and the times.
3. **`POST /sms`** `{ contactId, leadId?, template, variables }`:
   - needs Customers edit and an `Idempotency-Key`, or a key in the body;
   - refuses an opted-out customer (422 `SMS_OPTED_OUT`), no number (400), no connection (409), a blank left empty (400).
   - `GET /sms?contactId=` lists them.
4. **Opt-out:**
   - `Contact.smsOptOut { at, method }`; `ConsentEvent.channel` gains `sms`;
   - `POST /contacts/:id/sms-consent { optedOut }` (Customers edit);
   - an incoming SMS that says STOP (or the Hindi or Hinglish ruko or band) opts the customer out by itself.
5. **The webhook** `POST /api/v1/webhooks/sms/:key` (MSG91 does not sign its callbacks, so the address carries the per-company key; a wrong key is 404):
   - delivery reports are matched by message id within that company only, once per status, never going back;
   - an incoming SMS is stored as an inbound `SmsMessage`.
6. **The SMS step** `sms.send` `{ template, variables }` in workflows and sequences (the same blank values as WhatsApp templates):
   - it is skipped (not failed) for an opted-out customer or one with no number;
   - its key is `<run or enrollment>:<step>`, so **a retried job never sends twice**.
7. **Sequences stop** on an SMS reply too (with `stopOnReply`), and **always on an opt-out** (WhatsApp offers or SMS): a customer who said stop gets no more follow-ups.
8. **History:** SMS in the Customer 360 history (kind `talk`), with **Send SMS** (template, blanks, a preview) and the opt-out switch.
9. English and Hindi; 390 px.

### 8B — Power dialer and bulk actions

1. **`DialerSession`** (per member):
   - up to 200 items, each a lead and its customer with a status `pending`, `done` or `skipped`, its call and its outcome;
   - built from lead ids or a board (visible leads with a phone; the others are listed as left out).
   - API:
     - `POST /dialer/sessions`, `GET /dialer/sessions` (mine), `GET /dialer/sessions/:id`;
     - `POST /dialer/sessions/:id/items/:n/call`: click-to-call through Calling, **one press per call**;
     - `POST /dialer/sessions/:id/items/:n/result` `{ outcome, notes, minutes?, followUpInDays? }`: the outcome goes on the call placed for it, or a call is logged by hand (once per item); it can set the follow-up and moves to the next;
     - `POST /dialer/sessions/:id/items/:n/skip`; `POST /dialer/sessions/:id/finish`.
2. **`POST /bulk/leads`** `{ action, ids (≤ 200), params }` (Leads edit; `Idempotency-Key`):
   - actions: `assign`, `stage`, `followUp`, `tag`, `sequence`, `sms`;
   - every row goes through the existing services (visibility, versions, plan limits, consent);
   - the answer is `{ done, failed: [{ id, code, message }] }`.
3. **`dialer.html`**:
   - the session list and "start from a board";
   - the current customer (name, number, deal, last notes);
   - **Call** (or the number to dial from one's own phone when the company has no calling account);
   - outcome chips, a note, a follow-up (none, tomorrow, 3 days, a week), **Save and next**, Skip;
   - keys 1–8 for the outcomes, N for next.
4. **Boards (table):** row checkboxes and a bar: assign, move stage, follow-up, tag, add to sequence, send SMS, **call in the dialer**. The result says how many were done and lists the ones that were not.

## 5. Data model

- `SmsConnection { organizationId (unique), provider, authKeyEnc, senderId, templates[{ key, name, flowId, dltTemplateId, text, variables[] }], webhookKey (unique), status, lastError, lastSentAt }`
- `SmsMessage { organizationId, contactId, leadId, memberId, direction (out|in), source, templateKey, text, to, from, status, provider, providerMessageId, idempotencyKey, enrollmentId, runId, error, sentAt, deliveredAt }`
  - unique `(organizationId, idempotencyKey)` (partial) and `(organizationId, provider, providerMessageId)` (partial).
- `Contact.smsOptOut { at, method }`; `ConsentEvent.channel` gains `sms`.
- 8B: `DialerSession { organizationId, memberId, name, items[{ leadId, contactId, label, phone, status, callId, outcome, at }], position, status, stats }`.

## 6. Edge cases

- A template's blank without a value (the customer has no company): not sent (skipped in a sequence, 400 by hand), like WhatsApp templates.
- A delivery report for another company's message, or twice: nothing changes (it is matched within the key's company, once per status).
- A provider error:
  - the message is saved as `failed` with the reason;
  - in a sequence a 5xx retries the job, and the same key finds the saved message instead of sending again.
- Bulk SMS to 200 customers: each row is checked (opt-out, number); the opted-out ones are listed as failed with `SMS_OPTED_OUT`.
- The dialer with no calling account: "Call" shows the number to dial (`tel:` on phones); the result is logged by hand.
- A lead that is given away mid-session: its item is skipped with a reason when reached.

## 7. Acceptance checklist

- [ ] A reply or an opt-out stops future sequence steps (test).
- [ ] Retries do not duplicate sends (same key → the same message; test).
- [ ] The dialer logs the outcome on the call (test + browser).
- [ ] Bulk actions are permission-scoped and partly failed rows are reported (test).
- [ ] The test provider covers send, deliver, fail, retry, inbound STOP, a wrong key, and a duplicate report (test).
- [ ] No real call is placed without a person pressing Call, and only with a calling account (test: the dialer never dials by itself).
- [ ] Browser: Settings → SMS, Send SMS on Customer 360, the dialer, bulk on a board, at 390 px and in Hindi.

## 8. Scorecard targets

| # | Target | How it is measured |
|---|---|---|
| 1 | 0 duplicate sends under retries; 0 messages to opted-out customers | Tests |
| 2 | A call's outcome and the next customer in ≤ 2 taps in the dialer | Browser count |
| 3 | 50 leads given to someone (or added to a sequence) in ≤ 4 clicks, with failures listed | Browser + test |
| 4 | Delivery reports: tenant-resolved, deduplicated, never going back | Tests |
| 5 | 0 regressions; 390 px; Hindi | Full run + browser |

## 9A. What was built in 8A (D88), and how it differs from this spec

Built on 2026-10-23 as specified, with these differences:

1. **Opt-out and replies are recorded and act at the next step.**
   - The STOP words are stop, stopall, unsubscribe, cancel, end, quit, ruko, band, बंद and रुको (the whole message, any case).
   - An incoming SMS is matched to the customer by number within the company of the address.
   - A sequence checks before each step: an opt-out (SMS, or WhatsApp offers) stops it always; an SMS reply stops it when it stops on replies.
2. **A failed send that is worth retrying** (MSG91 unreachable or answering 5xx) is kept as `failed` with `retryable`; the next try with the same key sends it again. A refusal (4xx) is final. Missing blanks, an opt-out or no number make a sequence or workflow step **skipped**, not failed.
3. **By hand, the blanks are typed** (the customer's name and company come filled in); in workflows and sequences they are filled from the CRM (the same choices as WhatsApp template blanks, or fixed words).
4. **MSG91's "test" uses its old balance address** (UNVERIFIED), and the delivery report's and inbound SMS's fields are read loosely (UNVERIFIED). Both are to be confirmed with a real account.
5. **The Sales Automation page** (the user's own uncommitted work) lists the new step as "sms.send" with no settings yet. A sequence with SMS is made through the API or once that page adds the step's form. The workflow builder (D86) has it fully.
6. **Two fixes to D86 found here:**
   - the preview no longer asks for a name;
   - a draft with no `conditions` field no longer fails with 500 (both are tested).
7. **History:** SMS sent and received appear among the talks (with their status), and SMS opt-outs among the other events, labelled "SMS permission".

Files:
- **Backend:**
  - new: `constants/sms.js`, `models/SmsConnection.js`, `models/SmsMessage.js`, `integrations/sms/flow.js`, `integrations/sms/index.js` (with the test provider), `services/smsService.js`, `validators/sms.js`, `routes/sms.js`;
  - changed: `models/Contact.js` (`smsOptOut`), `models/ConsentEvent.js` (channel `sms`, method `sms_reply`), `services/contactService.js`, `routes/index.js`, `routes/contacts.js` (`POST /:id/sms-consent`), `routes/webhooks.js` (`POST /sms/:key`), `constants/automation.js` and `validators/automation.js` (`sms.send`), `services/automation/actions.js`, `services/automation/sequences.js`, `services/workflowService.js`, `services/timelineService.js`, `services/integrationStatusService.js`.
- **Frontend:** `js/settings-sms.js` (new), `Settings.html`, `js/customer-360.js`, `js/workflow-builder.js`, `js/settings-connections.js`, `css/style.css`, and 49 texts (`smsset.*`, `sms.*`, `c360.hist.sms*`, `conn.*.sms`, and the SMS texts of the workflow builder).
- **Tests:** `sms.test.js` (6); `workflowBuilder.test.js` and `integrationRegistry.test.js` updated.

Measured (tests and the isolated preview with the test SMS provider):
- **0 duplicate sends**:
  - the same key gave the same message;
  - a send after an outage went once;
  - a sequence step whose first try met an outage sent exactly once when the job retried.
- **0 messages to opted-out customers**: refused by hand (`SMS_OPTED_OUT`), skipped in workflows; sequences stop.
- **Delivery reports**:
  - a wrong key is 404;
  - another company's address matches nothing;
  - the same report twice and a late "submitted" changed nothing;
  - "delivered" set the time.
- **Browser** (Hindi, 390 px):
  - Customer 360: "Send SMS" with the name filled in, the preview, and "SMS sent: Quote ready · Sent" in the history;
  - a STOP from the customer turned off sending ("This customer asked not to get SMS");
  - the builder's SMS step previewed as skipped for that customer;
  - Settings → SMS found a new template's three blanks by itself.
- **Full run: 953 of 954 tests passed**; the one failure is the user's uncommitted `Sales Automation.html` (75 `auto.*` texts not added yet).
