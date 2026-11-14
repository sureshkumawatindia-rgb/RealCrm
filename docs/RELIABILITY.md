# Reliability: the status page, banners, messages tried again, failed sends

Phase 9 of the 100 phases (D151), 2026-11-14. When Meta (WhatsApp), Razorpay or Cashfree has
trouble, or the CRM's own background work runs late, everybody can see it, a message that could
not go waits and goes by itself, and whatever still did not go is on one list with "Try again".

## 1. The public status page

- **Address:** `https://crm.agreem360.com/status` (the server sends `/status` to
  `crm/frontend/status.html`). No sign-in; linked from the sign-in page's footer and from every
  banner. English and Hindi (the buttons at the top).
- **What it shows:** one line for everything at the top ("Everything is working", "Some things are
  having trouble", "Something is not working"); five parts — the CRM, its background work,
  WhatsApp (Meta), Razorpay, Cashfree — each with its state now, 30 days in India's days (a bar
  per day) and the share of time it was up; the platform's notices; the problems of the last
  30 days with how long each lasted. When the CRM itself cannot answer, the page says so.
- **The data:** `GET /api/v1/status` (public, any site may read it, kept 30 seconds). It says
  nothing about any company.

## 2. How the CRM knows something is wrong

Every call to Meta, Razorpay and Cashfree is counted per minute (`ServiceHealth`), without slowing
the call. Once a minute the job `status.evaluate` looks at the last 5 minutes:

| | When |
|---|---|
| Trouble opens | 5 or more failed calls, and half of the calls or more failed |
| It is "down" | 90% of the calls or more failed |
| It is back | 3 calls worked with under one in five failing; or, with nobody calling it, it answers a direct check (any answer below 500) |
| The CRM was not running | The CRM writes the time every minute; a gap of over 4 minutes is shown afterwards as a stretch it was down |
| Background work is late | A job waiting over 15 minutes; it ends once nothing waits over 5 minutes |

A failed call means no answer, an answer of 500 or more, or Meta's own error codes for its
trouble (2, 131016, 133004). A wrong number or a refused template is the company's matter, not
Meta's, and never opens trouble. The problems are `ServiceIncident`s (`source: auto`).

## 3. Banners inside the CRM

Every page with the top bar asks `GET /api/v1/status/notices` on load, every 3 minutes and when
the internet comes back. A company sees only what touches it: WhatsApp trouble only with a
WhatsApp number (or Instagram/Messenger) connected, a gateway's only when that gateway is
connected; background work and general notices for everyone. Each banner says what it means for
the person ("Messages you send will wait and go by themselves when it is back") and has
**Details** (the status page) and **×** (hides that notice for this person).

## 4. A message that could not go is tried again by itself

- **Chat messages** (WhatsApp, Instagram, Messenger): a send that may work later — Meta in
  trouble, no answer, too many at once (codes 1, 4, 80007, 130429, 131000, 131056, 131057) — stays
  "queued" and goes again after 1, 5, 15, 30 minutes, 1, 2 and 4 hours (about 8 hours in all);
  then it fails and the person who wrote it gets a bell note. In the Inbox the bubble says when
  the next try is, with **Don't send**; a failed one has **Try again** (for 7 days). A refusal
  that will not pass (a wrong number, a template problem, the 24 hours over) fails at once. A
  click never sends twice. A file that could not be uploaded is uploaded on the next try. Every 5
  minutes `message.sweep` marks a message left half-way by a restart as failed and asks again for
  a lost try. In rare cases Meta took a message but its answer was lost: the customer may get it
  twice.
- **SMS** (MSG91): one that failed for a reason that may pass goes again after 2, 10, 30 and 60
  minutes. Never to a customer who asked for no SMS.
- **Broadcasts**: while Meta is "down", a broadcast pauses for 10 minutes at a time and goes on
  when Meta is back (its page says why).
- **Webhooks to the company's own systems**: tried again as before, plus **Try again** in Failed sends.

## 5. Settings → Failed sends (owners and admins)

Everything of the last 7 days that did not go, newest first, on one list: chat messages (failed,
or waiting for their next try), SMS, webhooks, broadcasts with failed deliveries — with the
customer, what it was, the reason, when the next try is, **Try again** and **Open**. A filter by
kind and a count on the tab. Messages of a private number (D61) are for owners only.
`GET /api/v1/delivery-problems`, `POST /api/v1/delivery-problems/:kind/:id/retry`.

## 6. The platform admin page → Health

- Calls to Meta, Razorpay and Cashfree in the last 5 minutes (worked, failed, the last error).
- What is open now (with **End**), and what ended lately.
- **Webhooks that could not be processed** (from Meta and the gateways), grouped, with
  **Try them all again**; **Background jobs that gave up**, with **Try again**. Numbers and email
  addresses are taken out of the errors: this page never shows a company's customers.
- **Post a notice**: about everyone, WhatsApp or a gateway; information, trouble or down; a title
  and details in English and Hindi; optionally ending by itself after some hours. It shows on the
  status page and as a banner (section 3). Audited as `platform.notice_posted` and
  `platform.incident_ended`.

## 7. What you do

1. After go-live, open `https://crm.agreem360.com/status` once and keep the link handy: send it to
   customers who ask "is it down?".
2. If you already set up UptimeRobot (GO_LIVE_CHECKLIST step 5), nothing changes: it keeps
   watching `/api/v1/health`. Your support WhatsApp message can include the status link.
3. When Meta or a gateway announces planned work, post a notice from the platform admin page →
   Health, in both languages.

No `.env` change is needed.

## 8. For developers

- Files: `constants/serviceStatus.js`, `models/ServiceHealth.js`, `models/ServiceIncident.js`,
  `services/serviceStatusService.js` (record, evaluate, publicStatus, noticesFor, health, notices),
  `services/messageRetryService.js`, `services/deliveryProblemsService.js`,
  `services/platformHealthService.js`, `routes/status.js`, `routes/deliveryProblems.js`; pages
  `status.html` + `js/status.js` + `css/status.css`, `js/settings-delivery.js`, `crmServiceBanners`
  in `js/app.js`, the Health tab in `js/platform-admin.js`. Texts `status.*`, `deliv.*`,
  `padmin.health.*`, `inbox.retry.*`.
- Developer tools (`DEV_TOOLS`): `POST /api/v1/dev/simulate/service-trouble { on }` makes the test
  WhatsApp number fail as if Meta were in trouble; `POST /api/v1/dev/status-check` runs the
  minute's check now.
- Tests: `serviceStatus.test.js`, `messageRetry.test.js`, `deliveryProblems.test.js`; in a browser
  `e2e/reliability.spec.js` (the status page in both languages, a reply waiting while Meta is in
  trouble, Failed sends' Try again, a platform notice as a banner until it ends).
