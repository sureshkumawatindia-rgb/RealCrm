# BizNuma-style CRM Roadmap

Turning YELLOW CRM into a WhatsApp-first CRM for Indian SMBs (IndiaMART sellers, wholesalers, manufacturers, distributors, retailers).

- Brief: [BIZNUMA_CRM_MASTER_PROMPT.md](BIZNUMA_CRM_MASTER_PROMPT.md)
- Canonical backend spec: [../BACKEND-AUDIT-SPEC.md](../BACKEND-AUDIT-SPEC.md) (this roadmap extends it; where they differ, the decision log in section 9 wins and the spec gets updated in the phase that implements it)
- Status: **Phase 10 done** on 2026-10-08 on branch `feature/phase-10-saas` (built on the Phase 9 branch; nothing merged to main or pushed yet), checkpoints 10A–10G: plans, limits and the trial; paying for the plan (Razorpay Subscriptions, GST invoices); the public API, webhooks and the Meta Conversions API; the optional AI assistant; the installable app, web push and phone sign-in; the audit log, full export, company deletion and the deployment guide; acceptance. All ten phases of the brief are built. Still to check with real accounts: Razorpay Subscriptions (docs/BILLING_SETUP.md), a Claude API key (docs/AI_ASSISTANT.md), the platform's WhatsApp sign-in template, web push on a phone over https, and the earlier phases' real-account checks. Merged into `main` and pushed to GitHub on 2026-10-08 (with the GitHub Pages workflow made on GitHub). Hosting decided: Render (D18, `render.yaml`, docs/RENDER_SETUP.md) — the account and the first deploy are yours. Next: the WhatsApp-Web-style login (Google + mobile number + WhatsApp code, QR to log in from the phone, stay logged in 30 days). Status: **Phase 9 done** on 2026-10-07 on branch `feature/phase-9-reports` (built on the Phase 8 branch; nothing merged to main or pushed yet), checkpoints 9A–9C: reports API, the Reports page and dashboard on the server's numbers, AI Insights on server data, acceptance. Next: Phase 10 (SaaS layer and extras) after "go". **Phase 8 done** on 2026-10-07 on branch `feature/phase-8-payments-catalog` (built on the Phase 7 branch; nothing merged to main or pushed yet), checkpoints 8A–8D: payment gateways and links (Razorpay, Cashfree, a test gateway), links in the chat, dues and reminders, the WhatsApp catalog, acceptance. Still to check with real accounts: Razorpay/Cashfree keys and webhooks (guide: [PAYMENTS_SETUP.md](PAYMENTS_SETUP.md)) and a Meta catalog (WHATSAPP_SETUP.md). Next: Phase 9 (reports and dashboard) after "go". **Phase 7 done** on 2026-10-05 on branch `feature/phase-7-broadcasts` (built on the Phase 6 branch; nothing merged to main or pushed yet), checkpoints 7A–7D: consent and STOP/START, segments, CSV import, the broadcast engine, the Marketing page, acceptance. Still to check with a real Meta number: a marketing template broadcast and the daily limit read from Meta; Excel import waits for your OK to add a library. Next: Phase 8 (payments and catalog) after "go". **Phase 6 done** on 2026-10-03 (checkpoints 6A–6D); the bot still needs a check with a real WhatsApp number. **Phase 5 done** on 2026-10-03 (checkpoints 5A–5F); the WhatsApp parts (a document-header template, the customer link on a public address) still need the real Meta and hosting checks. Phase 4 done on 2026-09-29 except checks with real IndiaMART, Facebook and Google Ads accounts.

---

## 1. Checklist

Tick a box only when its acceptance check passes and the full test suite is green.

### Phase 0 — Audit and plan (no code changes)
- [x] Read backend/src, crm/frontend pages and scripts, BACKEND-AUDIT-SPEC.md and all docs
- [x] Verify the brief's "current codebase" facts against the code (section 2)
- [x] Check the official docs of every external API we plan to use (section 8)
- [x] Write this roadmap: gap table, data model, endpoints, socket events, job queues, decisions, risks, effort
- [x] Ask the open decisions: D10–D13 decided 2026-09-24 (section 9.2)

### Phase 1 — Foundation and hardening
- [x] Fix every known defect (section 2.3). Quotation totals are still computed in the browser until server quotations (Phase 5)
- [x] OrganizationMember, invites, roles and module permissions, tenant middleware, `requirePermission(module, action)`
- [x] Access + rotating refresh tokens with reuse detection and revocation (BACKEND-AUDIT-SPEC §10)
- [x] CORS allowlist, rate limits, NoSQL-operator sanitization, env validation at boot
- [x] Common building blocks: pagination, soft-delete plugin, audit log, idempotency records, atomic counters, error codes
- [x] `DATA_ENCRYPTION_KEY` in secretBox with Gmail tokens still readable (add the key to backend/.env; until then the Gmail key is used)
- [x] Frontend app.js: API base from `window.location.origin`, shared auth guard, 401 → refresh → logout
- [x] Test infra: mongodb-memory-server replica set; tests for tenant isolation, RBAC, token refresh, health still contains `dbState` (54 tests)
- [ ] Nothing that works today is broken. Verified: org profile + logo, health, the VS Code task backend (restarted and migrated on Atlas), sign-in/invite/refresh flows with a test verifier. **Needs your check with a real Google account: Google sign-in and Gmail connect.**

### Phase 2 — Core CRM moves to the server
Checkpoints: **A sales core (done)** → **B tasks + calendar (done)** → **C tickets + notes (done)** → **D documents (done)** → **E campaigns + automation config (done)** → **F Account Champions on the team API (done)** → **G final acceptance (done)**.
- [x] (A) Contacts, Leads (+activities, idempotent convert, version check), Products, Quotations (server totals, FY numbers)
- [x] (B) Tasks (assignee, related record, origin: manual / deal follow-up / automation) and calendar events (IST day + wall-clock times)
- [x] (C) Tickets (atomic numbers from #1001, customer link, resolved time) and notes on tickets and contacts
- [x] (D) Documents with private file storage behind a storage module (local disk now, S3/R2 later), signed-in downloads
- [x] (E) Campaign/Workflow/Sequence config; Run Now / Enroll create tasks on the server (idempotent, simulated actions reported)
- [x] (A) Deals page becomes the Kanban view of Leads; old deals imported as leads (D13)
- [x] (F) Account Champions page uses the members/invites API (Settings → Team & Access already does); crm_agents imported as invites
- [x] Every page uses `crmApi` instead of localStorage; UI looks the same (A–F; G: every page opened with the full imported data set, no script errors)
- [x] (A) `POST /imports/localstorage` with preview + report; Settings button "Move my browser data to server" (grows with each checkpoint)
- [x] Accept: two members of one org see the same data; another org sees none (`acceptance.test.js`: admin and an agent with "See all records" match the owner in all 11 modules; another organization gets 404 even with the ids)
- [x] Accept: grep finds no `crm_*` business keys in the frontend (only session/user keys) — enforced by `frontendStorage.test.js`; Settings → Data & Privacy is the one screen that reads the old keys, to move them
- [x] (G) Records deleted on the server never come back through the importer; `GET /exports/crm` and "Download CRM Data" replace the old browser export as the backup

### Phase 3 — WhatsApp Cloud API and shared team inbox
Checkpoints: **3A numbers + incoming messages (done)** → **3B conversations API, sending (24h rule), notes, quick replies, realtime (done)** → **3C Inbox page (done)** → **3D templates, media, Customer 360 chat, click-to-chat (done)** → **3E acceptance (done)**.
- [x] WhatsAppAccount, Conversation, Message, InternalNote, QuickReply, MessageTemplate — (3A) WhatsAppAccount, Conversation, Message, InboundEvent; (3B) QuickReply, internal notes as `notes` (parentType conversation); (3D) MessageTemplate
- [x] (3A) Settings → WhatsApp (manual IDs + token); webhook GET/POST with signature check — one URL per number (`/api/v1/webhooks/whatsapp/<key>`, D22)
- [x] Inbound: contact upsert → conversation → message → socket; new contact → lead (source WhatsApp); media to storage (3D: copied at once, checksum checked, retried on open)
- [x] Outbound: text/media inside 24h, templates outside; status webhooks update ticks — (3B) text, ticks, idempotent sends; (3D) files with Meta's limits, templates with header/body/link variables
- [x] (3D) Templates: sync (all pages), create/submit with Meta's rules checked first, delete, status webhook
- [x] (3C) Inbox.html + js/inbox.js + css/inbox.css (list, thread, contact panel, notifications, responsive), sidebar item after Dashboard with an unread badge; (3E) contact panel with lead stage (changeable), owner, quotations, open follow-ups (+ add one); sound for new messages (orders arrive with Phase 5)
- [x] Customer 360 chat timeline (+ "Message on WhatsApp" to write first); click-to-chat link + QR; dev-only inbound simulator (3D: photos, documents, voice notes on test numbers)
- [x] Accept (3E): a customer's message through the Cloud API code reaches every inbox member live and no other company; the first reply takes the chat and the unowned lead (D25); ticks, files, notes, stage change and a template after 24 hours work; forged webhooks are refused; another company gets 404 or empty lists for every Phase 3 record (`whatsappAcceptance.test.js`); browser run with an owner and an agent side by side against a fake Graph API, including an XSS attempt from a customer
- [ ] Checked with a real Meta account (your number, the webhook through a tunnel, a template approved by Meta) — **needs your Meta setup** (docs/WHATSAPP_SETUP.md)

### Phase 4 — Lead sources, auto-reply, auto-assign
Checkpoints: **4A lead intake + website forms + job queue (done)** → **4B IndiaMART (pull + push) (done)** → **4C Facebook Lead Ads, Google Ads, JustDial/TradeIndia (done)** → **4D auto-reply + assignment rules (done: engine + API)** → **4E Settings screens + acceptance (done)**.
- [x] (4A) Background jobs on MongoDB (D10 revised: own small queue instead of Agenda)
- [x] (4B) IndiaMART pull job (5-minute rule, dedupe by UNIQUE_QUERY_ID) + push endpoint — tested against a fake IndiaMART; **needs a check with your real CRM API key**
- [x] Facebook Lead Ads, Google Ads lead form, website form + embed snippet, JustDial/TradeIndia (whatever is officially possible, section 8) — (4A) website form + embed snippet (per-form public key, rate limit, honeypot, optional allowed sites, plain HTML fallback); (4C) Facebook Lead Ads (token check, Page subscription, signed leadgen webhook, lead fetched by a job) and Google Ads lead forms (key check, test data logged) per their official docs; JustDial and TradeIndia have no public docs, so a tolerant push address per source (any format; unreadable formats kept raw in the log) — TradeIndia's "My Inquiry API" pull waits for the parameters from a real account. All tested against fakes; **need checks with real accounts**
- [x] (4A) Normalize to Contact + Lead with source, sourceRef, raw payload; dedupe by phone (and by the source's own id); D26 for repeat enquiries
- [x] (4D) Auto-reply rules (template within 60 s), assignment rules (round-robin / by source, product, state, city; working hours; fallback; history) — engine, API and tests; (4E) Settings → Lead rules: working hours, assignment rules (with a ready-made suggestion, order, pause) and auto-replies (template picker, what fills each variable, live preview, counters); Leads shows each lead's owner and, under Notes, its history (assigned by which rule, auto-reply sent or why not)
- [x] Accept (4E): simulated IndiaMART lead → inbox + auto-reply + correct assignment, all within 60 s — `leadAcceptance.test.js` runs the real IndiaMART pull and push, the job worker, the rules and the Cloud API sender (IndiaMART and Meta replaced by a fake): the pulled lead reaches Arun's inbox and the pushed one Bela's (round-robin) with the filled-in template in about 0.1 s, live, and nobody else's; a repeat enquiry joins her lead without a second greeting. Browser run: the rules set up on the new screens, a test IndiaMART lead from Settings appeared in the agent's open inbox 0.1 s after the click, assigned by the rule, with the auto-reply

### Phase 5 — Pipeline, GST quotations, orders
Checkpoints: **5A GST engine + billing settings + quotations API (done)** → **5B Quotations page + Settings → Billing (done)** → **5C PDF + signed view link ("Viewed") (done)** → **5D send in the WhatsApp chat (done)** → **5E Orders + "Quote Sent, no reply" view (done)** → **5F acceptance (done)**.
- [x] "Quote Sent, no reply for N days" view (the new stages and the lead Kanban arrived in Phase 2 with D13) — (5E) Leads → "Quote sent, no reply" (2/3/5/7/14 days): leads at Quote Sent whose latest sent quotation waited that long without a WhatsApp reply, with the quotation (opened or not), the waiting days and links to the quotation and the chat
- [x] Organization settings: GSTIN, state code, bank, UPI ID, terms, number prefixes — (5A) API `/organization/billing` (bank, UPI, terms, validity, prefixes, round-off, stock option; GST state from the GSTIN or the company address); (5B) Settings → Billing screen; products get HSN/SAC and unit on the Products page
- [x] Quotations.html: items, discounts, GST breakup, validity, terms, revisions, PDF, send in chat, "Viewed" tracking — (5A) API: Quotation / Estimate / Proforma Invoice numbered per type and financial year, from a lead, contact or chat, product defaults, line discounts % or flat, CGST+SGST/UTGST or IGST, zero-rated, round-off, live preview, revisions kept, status rules, lead → Quote Sent on send, hourly expiry; migration 002 gives old quotations the new shape without changing amounts; (5B) Quotations.html: list (search, status, type), editor from a lead (its product and quantity become the first line), a customer picker, or a WhatsApp chat; items from products, % or ₹ discounts, live GST breakup from the server, place of supply, LUT, validity, terms, notes, revisions shown, mark sent / accepted / rejected, revise, delete; "Quotations" in the sidebar; the lead form's old quote items replaced by "Create quotation" (D29); the Inbox contact panel opens quotations and starts one from the chat; (5C) PDF (pdfkit, Noto Sans with ₹, logo, GSTIN, bank details, UPI QR, GST summary, page numbers, draft watermark) and the signed customer link that marks the quotation Viewed; (5D) "Send on WhatsApp": the PDF as a document with a message inside the 24-hour window, or an approved template with a document header (PDF attached, values suggested) outside it; the chat keeps the PDF; a draft becomes Sent and the lead Quote Sent
- [x] Orders.html: from accepted quote, stage pipeline, dispatch details, optional WhatsApp updates — (5E) "Create order" on an accepted quotation (once; the quotation is then locked to it); Received → Processing → Dispatched → Delivered → Payment Collected (any step, forwards or back) or Cancelled with a reason; transporter, LR, vehicle, expected delivery; history; stock taken once on dispatch (never below 0) and returned on cancel/move back when Settings → Billing says so; Payment Collected wins the lead; a WhatsApp update after each move (text in the 24-hour window, else a template with suggested values); orders in the Inbox contact panel; "Orders" in the sidebar
- [x] (5A) Money-math unit tests (intra/inter-state, rounding, discounts, zero-rated) — `gst.test.js`: CGST+SGST vs IGST (GSTIN first), UTGST, half-up paisa rounding (BigInt), % and flat discounts, fractional quantities, 0% items and LUT exports, round-off up/down/off, rate summary
- [x] Accept (5F): `quoteToCash.test.js` — through the real Cloud API code (Meta faked): a customer writes on WhatsApp, the agent who answers owns the lead, makes the quotation from the chat (their Gujarat GSTIN → IGST, a % discount, freight; ₹1,03,834 after round-off), the PDF is uploaded and sent as a document with the link, the lead moves to Quote Sent, four days without a reply put it under "Quote sent, no reply" (only for its owner), the customer opens the link (Viewed) and replies, accepts; the order is dispatched with the LR number (stock 100 → 90), the customer gets a text update and, after the window closed, the template; payment collected wins the lead; the owner's backup has it all; a teammate without the lead and another company get 404 everywhere and a changed link is refused. Browser run of the same path from the Inbox to "Payment Collected"

### Phase 6 — Automation engine, FAQ bot, follow-ups
- [x] 6A: job-backed workflows — 8 triggers (lead created, WhatsApp message with keywords, stage change, order stage, payment, and scanned: no reply for N hours, quotation not accepted after N days, task overdue), 5 condition kinds (source, tag, stage, owner, working hours), 10 step types (WhatsApp text and template, assign, tags, stage, task, notify, wait, signed webhook); dedupe, retries, loop guard; Phase 2 workflows migrated paused (D32)
- [x] 6A: run logs in the UI (per run and step, Stop, test run for a lead) and the CRM bell (D31)
- [x] 6B: sequences per customer — steps on day 0/2/5 … (WhatsApp template or text, task, notify, tag, stage, assign) in working hours, stop on a WhatsApp reply or a won/lost lead, enroll by hand or with the workflow step "Add the customer to a sequence", who-is-in-it list with Take out; Phase 2 sequences migrated paused (migration 004)
- [x] 6C: WhatsApp FAQ bot — answers by keyword (any script) with text, reply buttons (1–3) or a list (4–10) whose options open other answers or a person; greeting and away message once a day per chat; hand-off by keyword or button rings the owner's bell; quiet once an agent has the chat (D33); per-chat on/off in the Inbox; auto-reply rules leave WhatsApp enquiries to the greeting
- [x] Accept (6D): `automationAcceptance.test.js` — through the real job worker, engine, sequences, bot, Cloud API code (Meta faked), signed webhooks and live sockets: an IndiaMART enquiry is given to Arun by a workflow, which starts the follow-up sequence and rings his bell; the day-0 and day-2 templates go out; the customer's WhatsApp reply stops the sequence (no day-3 task) and the bot keeps out of Arun's chat; a new WhatsApp customer gets the bot's list, picks "Price list", then "Talk to a person" — the bot stops and the owner's bell rings; Arun answers and owns the customer; a day of silence makes the no-reply scan create his reminder task; the run log, who-is-in-the-sequence list and the backup show it all; another company sees and hears nothing. Browser run of the same path

### Phase 7 — Broadcasts and segmentation
- [x] 7A: tags on the customer form, saved segments (tags, places, source, products, lead stage, owner; preview with reach) — API now, builder UI in 7C; CSV import with column mapping, phone normalization, dedupe and a dry run; consent per customer with STOP/START on WhatsApp (D35). Excel import waits for your OK to add a library (CSV UTF-8 from Excel works today)
- [x] 7B: broadcast engine — template + per-customer variables + segment, now or scheduled, batches within Meta's daily limit (D38), per-recipient sent/delivered/read/replied/failed/skipped, monthly quota by plan (D34), cost estimate by category (D37), pause/resume/cancel; API now, the Marketing page in 7C
- [x] Accept (7D): `broadcastAcceptance.test.js` — through the CSV import, the job worker, the Cloud API code (Meta faked, reporting TIER_2K), signed webhooks: customers imported as agreed, one opts out with STOP (confirmed), "Tier A – Rajasthan" reaches the other three, the broadcast fills each name in, one number is refused by WhatsApp, delivered and read statuses and a reply come back, the admin sees sent 2 · delivered 2 · read 1 · replied 1 · failed 1 and the quota; the agent and another company get 403/404. Browser run of the segment → broadcast → results path in 7C
- [x] 7C: Marketing page — tabs Campaigns | WhatsApp broadcasts | Segments: segment builder with a live count, broadcast composer (template, values per customer, segment, reach, cost, limits, now or scheduled), results with a sent → delivered → read → replied funnel and every customer's status with a link to the chat; pause/resume/cancel (the inline-script split was fixed in Phase 1)

### Phase 8 — Payments and catalog
- [x] 8A: Razorpay and Cashfree payment links with each organization's own keys (plus a test gateway for development), for an order, a quotation or an amount; signed webhooks and a 10-minute status check (D42) → paid → order paid, quotation accepted and its order made, lead won (D40), receipt on WhatsApp (D41), bell; payments entered by hand; API now, the pages in 8B
- [x] 8B: send the link in the chat from an order, a quotation or the Inbox (text in 24 hours, else a template), Settings → Payments, the payment card and "Record payment" on orders, the "Payment due" list by age, the reminder workflow (trigger "order still not paid after N days" + step "send the payment link"); guide in PAYMENTS_SETUP.md
- [x] Accept (8D): `paymentAcceptance.test.js` — the brief's test 3 through the job worker, the Cloud API code and the Razorpay client (both faked at fetch) and signed webhooks: a customer writes, the agent answers, sends the GST quotation PDF in the chat, then the payment link; Razorpay's webhook pays it: the quotation is accepted, the order made and paid, the lead won, the receipt sent, the agent's bell rings; then the product goes to the Meta catalog, a cart comes back as an order, a part-payment link is paid half by webhook and the rest found by "Check now", and the dues list empties; another company sees none of it
- [x] 8C: Meta Commerce catalog per WhatsApp number (checked with Meta, shop and cart settings), products synced at once / daily / by hand (prices with GST, D43; photo and price required; removals), one product or a list sent in a chat, carts sent back become orders at Received with a thank-you and a bell note (D44); Products, Settings → WhatsApp, Inbox and Orders pages

### Phase 9 — Reports and dashboard
- [x] 9A: reports API for a range of India days — overview, trend, agent performance (first and average response time, chats handled, leads by stage, won, order value, collected, tasks, tickets), source funnel, quotation win rate, broadcast performance, payment collection, dashboard and insights figures, CSV export (formula-safe); scope by role (D45), response time by a teammate (D46), counted on request (D47)
- [x] 9B: Reports page on the server's numbers — one period for every chart (presets, this/last month, financial year, two dates; "now" panels say so), tabs Overview, Sales, Leads & Marketing, WhatsApp & Team, Payments, Support, CSV of the open tab; dashboard KPIs from the server (chats waiting, new leads, pipeline, quotes waiting, collected, due, tasks)
- [x] 9C: AI Insights on server data (`/reports/insights`: weighted pipeline, leads that need attention, chats waiting, old dues, 90-day win rate and reply time, the leads worth most with a next step; "Ask" answers from the same numbers, no language model yet)
- [x] Accept (9C): `reportsAcceptance.test.js` — the brief's test 5: customers write through signed webhooks (WhatsApp says when), two agents answer, one sells through a test-gateway payment link (worker), and the admin opens the agent performance report: reply times (~10 and ~25 minutes), chats, wins, order value and money collected per agent, the CSV, the overview and the dashboard; the agent sees only their own row, an agent without Reports gets 403, another company sees nothing

### Phase 10 — SaaS layer and extras
- [x] 10A: plans and limits as data, usage counted from the records, 30-day Growth trial for new companies (existing ones comped, D48), locked after the trial without a plan (D49), limits on users, WhatsApp numbers, contacts (by hand and import; never inbound), templates, quotations a month, broadcasts, and the paid features (workflows, payment links, catalog); Settings → Plan & usage, the trial banner, the upgrade prompt
- [x] 10B: Razorpay Subscriptions on the platform's account (D50): choose (the rest of the trial stays free), upgrade now / downgrade next month, cancel at month end, Check now, signed webhooks + a 6-hourly check, payment due / halted (locked); a gap-free GST tax invoice (CGST+SGST or IGST) with a PDF for every charge; trial reminders; a test gateway with its own checkout page (docs/BILLING_SETUP.md)
- [x] 10C: public REST API at /api/public/v1 (hashed keys with scopes acting as their owner/admin, per-key rate limit, contacts, leads like a lead source, quotations, orders, products, WhatsApp templates; D51), signed outbound webhooks for 8 business events with retries, a delivery log and auto switch-off (D52), Zapier/Make guide (docs/INTEGRATIONS.md), Meta Conversions API for CRM lead stages (D53); Settings → API & webhooks
- [x] 10D: optional AI assistant on the Claude API (official SDK, user approved): reply suggestions for agents (Sonnet 5.5) and, if switched on, answers to customers by itself (Haiku 4.5) only when sure, else a hand-off; grounded in the company's facts with prompt caching; JSON answers; usage and cost per company with a monthly budget (D54; docs/AI_ASSISTANT.md)
- [x] 10E: installable app (manifest, service worker, offline page), web push for the bell's notes (VAPID + RFC 8291 with Node's crypto, no library), sign-in with a WhatsApp code to a number verified once (platform number and authentication template; D55, D56)
- [x] 10F: audit-log viewer (Settings → Audit log), full data export (every section, no secrets), company deletion after a 7-day grace period (D57), the platform owner's plan command (scripts/plan.js), TRUST_PROXY, docs/DEPLOYMENT.md
- [x] Accept (10G): `saasAcceptance.test.js` — trial, locked after it, Pro paid with a GST invoice, upgrade to Growth for the API, an ERP's API key and signed webhook, an API lead echoed back signed, an AI reply suggestion sent by the agent, a phone notification, the full export without secrets, the audit log, deletion after the waiting period

---

## 2. What the code actually looks like (verified 2026-09-24)

### 2.1 Brief facts that match the code

| Brief says | Verified |
|---|---|
| Node 24, Express 5, Mongoose 9, Joi, winston, multer, googleapis, helmet, cors, morgan; Jest + supertest; CommonJS, 2-space | Yes (node v24.20.0, express 5.2.1, mongoose 9.9.5, joi 18.2.8, jest 30.5.1, helmet 8.3.0) |
| app.js serves /crm/frontend before helmet, /api/v1, /uploads, 404 handler, errorHandler, port 3000 | Yes |
| auth.js: POST /auth/google verifies ID token, creates User + Organization on first login, returns app JWT | Yes (JWT `sub` = Google id, `uid` = user id, `JWT_EXPIRES_IN` default `7d`) |
| organization.js: GET/PATCH + logo upload/delete to uploads/ | Yes (fields `gst`, `size`, `pincode`) |
| gmail.js: read-only Gmail OAuth; tokens encrypted with secretBox (AES-256-GCM) | Yes (key = SHA-256 of `GMAIL_TOKEN_ENCRYPTION_KEY`) |
| `authenticate` loads req.user; tenant = req.user.organizationId | Yes |
| errorHandler shape `{ success:false, message, code, requestId, errors? }` | Yes |
| Models: User, Organization (strict:false), GmailConnection, OAuthState | Yes |
| 19 HTML pages, vanilla JS, style.css tokens, Font Awesome, "YELLOW CRM" | Yes (see 2.2 for one exception) |
| `crmApi` is the only fetch wrapper; `CRM_API_BASE` hard-coded; `injectGlobalNavItems` pattern | Yes |
| Only login.js and settings.js call the API; business data in the listed `crm_*` keys | Yes (all 19 keys found, plus `crm_deals_demo_cleared`) |
| Inline auth check per page | Yes (every page except login.html) |
| Enums: lead `New/In Progress/Won/Lost`; deal `Lead/Qualified/Proposal/Negotiation/Won/Lost`; ticket statuses and priorities; automation actions incl. "Send Email (simulated)"; steps `Email/Call/Task/Wait`; marketing `Email/Social/SMS/Ads/Event`; MODULES in accounts.js | Yes (15 MODULES incl. "Accounts") |

### 2.2 Differences and new findings (code wins)

1. **Empty layer folders already exist.** `src/controllers`, `services`, `repositories`, `validators`, `constants` exist but are empty (the brief says they don't exist). No functional impact.
2. **Git layout.** `OriginalCrm - Copy/` is untracked in the parent repo, but it is **its own git repository** with remote `github.com/sureshkumawatindia-rgb/RealCrm` (branch `main`, in sync). It has no root `.gitignore`, and **138 files of a root-level `node_modules/` are committed** (from the stray root `package.json` that only lists `jsonwebtoken`; the backend has its own). `backend/.env` was never committed (checked the history). See decision D11.
3. **Quotation bug is broader than described.** In `js/leads.js` a new quotation is created on **every save** (create or edit) whenever the lead has a product and quotation items, not only on WON. Repeated edits create duplicate quotations, numbered in the browser. The new lead id is found via `getLeads()[0]`, which relies on insertion order.
4. **Deal wipe path.** `deals.js` deletes `crm_deals` when `crm_deals_demo_cleared` is missing. Settings → Reset deletes every `crm_*` key including that marker, so an import of an older backup followed by opening Deals wipes the imported deals.
5. **Expired sessions look logged in.** `isAuthenticated()` only checks that the token has three dot-separated parts; `crmApi` has no 401 handling. After the 7-day JWT expires, pages open but every API call fails.
6. **First login always creates an organization.** This conflicts with invites (an invited agent would get their own empty org). See decision D12.
7. **Brand mismatch.** login.html says "By continuing you agree to ONE CORE CRM's usage policy"; everything else says YELLOW CRM. Recommendation: YELLOW CRM everywhere (Phase 1, one line).
8. **SVG logos on the app's own origin.** Logo upload accepts SVG and `/uploads` is now served from the same origin as the pages (127.0.0.1:3000). Helmet's CSP (`script-src 'self'`) on /uploads blocks inline SVG scripts, so this is mitigated, not ideal. Phase 1: add `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` on /uploads (or drop SVG).
9. **Browser data is per address.** localStorage belongs to one origin. Data entered at `127.0.0.1:5501` (VS Code Live Server) is **not visible** at `127.0.0.1:3000` (the new single-server address). Until Phase 2 moves data to the server: export on the old address (Settings → Data & Privacy → Export) and import on the new one.
10. **Google sign-in origin.** Sign-in from `http://127.0.0.1:3000` needs that origin in the Google OAuth client's "Authorized JavaScript origins". The button renders; a real sign-in there has not been confirmed yet.
11. **Stale docs.** `BACKEND-AUDIT-SPEC.md` §1 says there are no fetch calls (login/settings now call the API) and lists lead statuses `New|Contacted|Qualified|Proposal|Negotiation|Won|Lost` (the code has `New|In Progress|Won|Lost`). `docs/API.md` says the bearer token is a Google ID token (it is the app JWT), lists `GOOGLE_REDIRECT_URI` on port 5500 (it is 3000), and contains two documents pasted together. Phase 1 updates both.
12. **Tests.** 2 suites, 4 tests. `health.test.js` fails today because it never connects to MongoDB (health returns 503). Phase 1 fixes it with mongodb-memory-server.
13. **Unescaped rendering spots.** `escapeHtml` is used widely, but a few templates interpolate raw values (e.g. `statusBadge` in leads.js, the agent review step in accounts.js). Low risk today (values come from selects), real risk once WhatsApp and lead-source data flow in. Phase 1 adds a lint-style grep check; Phase 2 fixes each page as it is rewritten.
14. **Env keys present** (names only): `PORT, MONGO_URI, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, FRONTEND_URL, GMAIL_TOKEN_ENCRYPTION_KEY, PUBLIC_URL, UPLOAD_DIR, JWT_SECRET, JWT_EXPIRES_IN`. `MONGO_URI` points to MongoDB Atlas (a replica set), so transactions already work there.

### 2.3 Known defects to fix in Phase 1

From the brief, all confirmed in the code:

- accounts.html legacy account form (`#accountForm`, `#accountsTable`) is never wired; accounts.js manages agents.
- Marketing.html runs an inline campaign script and never loads js/marketing.js; the status lists differ (inline Kanban `Draft/Completed` vs filter `Draft/Active/Paused/Completed`).
- Company fields: company.html + routes/organization.js use `gst/size/pincode`; app.js uses `taxId/employees/zip`. Standardize (D14) and migrate.
- deals.js demo cleanup can wipe deals (2.2 #4).
- Lead save creates quotations; totals and numbers computed in the browser (2.2 #3).
- middleware/requestId.js imports `uuid` (undeclared, resolves via gaxios) and never uses it.
- config/env.js hard-codes a Google client ID fallback; no env validation at boot.
- App JWT has no refresh/revocation; `cors()` allows every origin; no rate limiting.

Added by this audit: 2.2 #2 (untrack root node_modules, add .gitignore), #5, #6, #7, #8, #11, #12.

---

## 3. Gap table

| # | BizNuma feature | Current state | What to build | Phase |
|---|---|---|---|---|
| 1 | Shared WhatsApp team inbox (Cloud API, many agents, assignment, notes, multiple numbers) | Nothing. No WhatsApp anywhere; agents exist only in localStorage | WhatsAppAccount/Conversation/Message models, Meta webhook, send service with 24h rule, Socket.IO, Inbox page, OrganizationMember-based assignment | 1 (members), 3 |
| 2 | Lead capture (IndiaMART, JustDial, TradeIndia, FB Lead Ads, Google Ads, website, WhatsApp) with source tracking | Manual lead form in localStorage; no source field | LeadSourceConnection per org, pull jobs + push/webhook endpoints, normalizer to Contact + Lead, dedupe by phone and source ref | 3 (WhatsApp), 4 |
| 3 | Instant auto-reply < 60 s, 24/7 | None | AutoReplyRule + job fired on lead creation; template send outside 24h window | 4 |
| 4 | Auto-assignment (round-robin, source/region/product) | None | AssignmentRule engine with atomic round-robin pointer, working hours, fallback, history | 4 |
| 5 | Pipeline New → Contacted → Quote Sent → Negotiation → Won/Lost + "quoted but silent" | Lead `New/In Progress/Won/Lost`; separate Deals Kanban | Server-side stages with transition rules, Lost reason, Kanban, smart view on `lastQuoteSentAt` vs `lastCustomerReplyAt` | 2, 5 |
| 6 | GST quotations in chat (CGST/SGST/IGST, PDF), estimates, proforma | Browser-computed quotations, no page, no PDF, no GST split | Pricing service (paise), Quotation model with snapshots + revisions, FY counters, PDF, send as WhatsApp document, signed "viewed" link | 5 |
| 7 | Payment links (Razorpay, Cashfree) with status sync | None | Payment gateway connections (encrypted keys), PaymentLink model, signed webhooks, receipt message | 8 |
| 8 | FAQ chatbot (price, MOQ, delivery, payment terms), catalogue sending | None | Keyword rules + interactive buttons/lists, hand-off, greeting/away messages | 6 |
| 9 | Follow-up sequences that stop on reply | Sequences only create tasks; steps simulated | Sequence enrollments driven by jobs; stop on inbound message | 6 |
| 10 | Broadcasts to tagged segments with stats and opt-out | Campaigns are records only; no WhatsApp channel | Tags, segments, CSV import, consent, throttled broadcast jobs, per-recipient status, quota, cost estimate | 7 |
| 11 | Distributor order pipeline | None | Order model + Orders page, stage history, dispatch details, optional WhatsApp updates | 5 |
| 12 | WhatsApp catalog (Meta Commerce) sync | Products in localStorage only | Catalog sync job, product/product-list messages, catalog orders → Orders | 8 |
| 13 | Reports: agent FRT/response time/handled/closed; source conversion | Reports from localStorage; charts mix date ranges | Server aggregations with date ranges, CSV export, rollups | 9 |
| 14 | SaaS: plans + limits, trial, public API + webhooks, Zapier/Make, Meta CAPI, AI add-on | Single-tenant-per-user, no billing | Plans config, usage meters, subscriptions, API keys, outbound webhooks, CAPI, Claude-based assistant, PWA, OTP login | 10 |
| — | Foundation: tenancy, RBAC, refresh tokens, audit, idempotency, validation, rate limits | Only `authenticate` + org by user; no RBAC | Section 4 building blocks | 1 |

---

## 4. Target architecture (summary)

Keeps the stack: Express + MongoDB/Mongoose + vanilla HTML/CSS/JS, served by the one Node server on port 3000.

```text
backend/src/
  app.js, server.js            server.js also starts Socket.IO and (if enabled) the job worker
  config/                      env (validated at boot), database, logger, plans.js (plan limits as data)
  constants/                   roles, modules, permissions, stages, sources, error codes
  middleware/                  auth, tenant, requirePermission, validate(Joi), rateLimit, sanitize, rawBody
  routes/ -> validators/ -> controllers/ -> services/ -> repositories/ -> models/
  policies/                    record scope (own vs view-all)
  integrations/
    whatsapp/                  provider interface; MetaCloudProvider, MockProvider
    leadSources/               indiamart, justdial, tradeindia, facebookLeads, googleAdsLeads, websiteForm
    payments/                  razorpay, cashfree (interface: createLink, verifyWebhook, parseEvent)
    storage/                   local uploads/ now; S3/R2-compatible later
    ai/                        optional
  jobs/                        queue interface + driver (D10), job handlers
  realtime/                    Socket.IO setup, JWT auth, rooms org:<id>, conv:<id>, user:<id>
  utils/                       money (paise), gst, phone (E.164), pagination, secretBox, idempotency
  tests/
```

Key rules:

- Every repository query takes the tenant context (`organizationId` from the token's active membership). Never accept organizationId, owner, role, totals, counters or probabilities from the client.
- Agents see only assigned records and conversations unless they have the `view_all` permission.
- Webhooks: routes mounted **before** `express.json()` with `express.raw()` so signatures are computed on the raw body; reply 200 fast; store an `InboundEvent` keyed by provider event/message id (unique index = idempotency); a job does the real work.
- Per-org secrets (WhatsApp token, IndiaMART key, Razorpay keys) encrypted with secretBox under `DATA_ENCRYPTION_KEY`; the old Gmail key stays as a read fallback so existing Gmail connections keep working; secrets are never returned to the browser (only "configured: yes/no" and the last 4 characters).
- The app runs fully without real credentials: MockProvider for WhatsApp, simulator endpoints (dev only), fake lead-source payloads, payment test mode.
- Frontend: `CRM_API_BASE` = `${window.location.origin}/api/v1` when served by the backend, fallback `http://127.0.0.1:3000/api/v1` (Live Server). Shared auth guard, 401 → refresh → logout, loading/empty/error states. Untrusted text rendered with `textContent`/`escapeHtml` only.
- Transactions need a replica set: Atlas already is one. Local MongoDB: see section 11. Tests: `MongoMemoryReplSet`.

---

## 5. Data model

All tenant collections have `organizationId`, `createdAt`, `updatedAt`, `deletedAt` (soft-delete plugin: default queries add `deletedAt: null`), and `createdById` where a person creates the record. Every index below is prefixed with `organizationId` unless marked global. Money is **integer paise** (`...Paise`).

### 5.1 Identity and tenancy (Phase 1)

| Collection | Key fields | Indexes | Notes |
|---|---|---|---|
| organizations | name, logoUrl, ownerId, profile {industry, size, foundedYear, website, email, phone, address, city, state, stateCode, country, postalCode, description}, gstin, bank {accountName, accountNumber, ifsc, bankName, branch}, upiId, defaultTerms, numberPrefixes {quotation, estimate, proforma, order, ticket}, businessHours {timezone "Asia/Kolkata", days[], start, end}, settings {reduceStockOnDispatch, leadStages (later)}, planKey, trialEndsAt | — | Field names per D14; migrate `gst → gstin`, `pincode → postalCode`, `size` kept, `founded → foundedYear` |
| users | googleId (unique sparse, global), email (unique, global), name, picture, phoneE164 (later, OTP), lastLoginAt, disabledAt | global | `organizationId` moves to memberships (kept read-only during migration) |
| organizationmembers | organizationId, userId, role owner/admin/agent/viewer, modules[] (MODULES keys), permissions[] (e.g. `contacts:view_all`, `inbox:view_all`, `broadcast:send`), status active/disabled, displayName, mobile, assignable, workingHours, lastAssignedAt | unique (org, userId); (org, role) | Replaces crm_agents |
| invites | email, role, modules[], permissions[], tokenHash, invitedById, expiresAt (TTL), acceptedAt | unique (org, email) where not accepted; tokenHash unique | Accept via Google login with the same email |
| sessions | userId, organizationId (active org), familyId, tokenHash, expiresAt (TTL), revokedAt, replacedByHash, userAgent, ip | tokenHash unique (global); (userId, familyId) | Refresh-token rotation; reuse → revoke family |
| auditlogs | actorId, action, entityType, entityId, diff (redacted), requestId, ip, userAgent | (org, entityType, entityId, createdAt -1); (org, createdAt -1) | Append-only |
| idempotencyrecords | userId, operation, key, requestHash, statusCode, response, expiresAt (TTL 24h) | unique (org, userId, operation, key) | For creates/converts/sends |
| counters | name (e.g. `ticket`, `quotation:QT:2026-27`, `order:2026-27`), seq | unique (org, name) | `findOneAndUpdate({$inc})` |

### 5.2 Core CRM (Phase 2)

| Collection | Key fields | Indexes | Notes |
|---|---|---|---|
| contacts | phoneE164, name, email, company, gstin, stateCode, state, city, address, tags[], source, sourceRef, ownerId, lifecycle lead/customer, consent {marketing opted_in/opted_out/unknown, changedAt, method}, lastInboundAt, legacyIds[] | unique (org, phoneE164) where deletedAt null; (org, ownerId, lifecycle); (org, tags); (org, email) | Replaces customers + accounts; contacts without a phone allowed only from import (phoneE164 sparse) |
| leads | contactId, title, stage, lostReason, source, sourceRef, productIds[], quantity, expectedValuePaise, followUpAt, ownerId, lastQuoteSentAt, lastCustomerReplyAt, convertedAt, version | (org, stage, createdAt -1); (org, ownerId, stage); (org, followUpAt); unique (org, source, sourceRef) where sourceRef exists | The opportunity record (see D13) |
| leadactivities | leadId, contactId, type, text, actorId, meta | (org, leadId, createdAt -1) | Append-only |
| products | name, sku, category, description, unit, hsnSac, gstRatePct, pricePaise, moq, stockQty, images[], active, catalogRetailerId | (org, active, category); (org, nameNormalized) | Tax-exclusive price; GST rate stored as a number (slabs changed in 2025, don't hard-code a list) |
| deals | — | — | Not created: one pipeline (D13); legacy deals import as leads |
| tasks | title, description, assigneeId, dueAt, priority, status, relatedType, relatedId, completedAt | (org, status, dueAt); (org, assigneeId, status) | crm_deal_tasks merge here with relatedType `Lead` |
| calendarevents | title, type, startAt, endAt, timezone, assigneeId, relatedType, relatedId | (org, startAt, endAt); (org, assigneeId, startAt) | |
| tickets | number (counter), subject, contactId, category, priority, status, assigneeId, dueAt, resolvedAt | unique (org, number); (org, status, priority, dueAt) | |
| notes | parentType (ticket/contact/lead), parentId, body, authorId | (org, parentType, parentId, createdAt -1) | Replaces crm_customer_notes and ticket notes |
| documents | name, category, ownerId, relatedType, relatedId, tags[], storageKey, linkUrl, mimeType, sizeBytes, checksum | (org, relatedType, relatedId); (org, category, createdAt -1) | Storage abstraction |
| campaigns / workflows / sequences | as BACKEND-AUDIT-SPEC §3; workflows get trigger/conditions/actions validated by allowlist | (org, status) | Execution arrives in Phase 6 |
| imports | source `localstorage`, status, preview, report {created, skipped, rejected[], unresolved[]} | (org, createdAt -1) | |

### 5.3 WhatsApp and inbox (Phase 3)

| Collection | Key fields | Indexes | Notes |
|---|---|---|---|
| whatsappaccounts | wabaId, phoneNumberId, displayPhone, verifiedName, encryptedAccessToken, status, qualityRating, messagingLimit, isDefault | **unique phoneNumberId (global)**; (org, isDefault) | A number belongs to one org |
| conversations | contactId, whatsappAccountId, assigneeId, status Open/Pending/Closed, lastInboundAt, lastMessageAt, lastMessagePreview, unreadCount, tags[] | unique (org, contactId, whatsappAccountId); (org, assigneeId, status, lastMessageAt -1); (org, status, lastMessageAt -1) | `lastInboundAt` drives the 24h window |
| messages | conversationId, contactId, direction in/out, type (text/image/document/audio/video/location/template/interactive), text, media {storageKey, mimeType, sizeBytes, sha256, providerMediaId}, template {name, language, variables}, interactive, providerMessageId, status sent/delivered/read/failed + sentAt/deliveredAt/readAt/failedAt, error {code, title}, sentById, replyToId, pricing {category, billable} | **unique providerMessageId (global, sparse)**; (org, conversationId, createdAt -1) | Idempotent webhook processing |
| internalnotes | conversationId, authorId, body, mentions[] | (org, conversationId, createdAt -1) | Never sent to the customer |
| quickreplies | shortcut, title, body, attachments[] | unique (org, shortcut) | "/" menu |
| messagetemplates | whatsappAccountId, wabaId, name, language, category, status, components, providerTemplateId, rejectedReason, lastSyncedAt | unique (org, wabaId, name, language) | |
| inboundevents | provider, eventId, organizationId (when resolved), payload (size-capped), status, attempts, error, processedAt | **unique (provider, eventId) global**; TTL 60 days | Shared by all webhooks |

### 5.4 Lead sources and routing (Phase 4)

| Collection | Key fields | Indexes |
|---|---|---|
| leadsourceconnections | type (indiamart/justdial/tradeindia/facebook/googleads/website), status, encryptedCredentials, publicKey (website form), webhookTokenHash (push URLs), cursor {lastEndTime}, lastPolledAt, lastError | unique (org, type, name); webhookTokenHash unique global |
| autoreplyrules | sources[], onlyNewContacts, template {name, language, variableMap}, delaySeconds, active | (org, active) |
| assignmentrules | priority, conditions {sources[], productIds[], states[], cities[]}, strategy round_robin/specific, memberIds[], respectWorkingHours, fallbackMemberId, rrPointer | (org, active, priority) |
| assignmenthistories | entityType, entityId, fromMemberId, toMemberId, ruleId, reason | (org, entityType, entityId, createdAt -1) |

### 5.5 Sales documents, orders, payments (Phases 5 and 8)

| Collection | Key fields | Indexes |
|---|---|---|
| quotations | type Quotation/Estimate/Proforma, number, fy, revision, rootId, contactId, leadId, status Draft/Sent/Viewed/Accepted/Rejected/Expired, supplyType intra/inter, placeOfSupplyStateCode, items[] snapshot {productId, name, hsnSac, unit, qty, unitPricePaise, discount {type pct/flat, value}, taxablePaise, gstRatePct, cgstPaise, sgstPaise, igstPaise, lineTotalPaise}, totals {taxable, cgst, sgst, igst, grand}, validUntil, terms, pdfStorageKey, viewTokenHash, sentAt, viewedAt, calcVersion | unique (org, number); (org, contactId, createdAt -1); (org, status, sentAt) |
| orders | number, contactId, quotationId, items[] snapshot, totals, stage Received/Processing/Dispatched/Delivered/Payment Collected/Cancelled, stageHistory[], dispatch {transporter, lrNumber, dispatchedAt}, paymentStatus, amountPaidPaise | unique (org, number); (org, stage, updatedAt -1) |
| paymentconnections | provider, mode test/live, encrypted keyId/keySecret/webhookSecret | unique (org, provider) |
| paymentlinks | provider, providerLinkId, quotationId, orderId, contactId, amountPaise, status, shortUrl, payments[] {providerPaymentId, amountPaise, method, paidAt} | unique (provider, providerLinkId) global; (org, status) |

### 5.6 Automation, broadcasts, SaaS (Phases 6, 7, 10)

| Collection | Key fields | Indexes |
|---|---|---|
| sequenceenrollments | sequenceId, contactId, leadId, stepIndex, nextRunAt, status active/stopped/completed, stopReason | (org, status, nextRunAt); unique (org, sequenceId, contactId) where active |
| automationruns | workflowId, trigger, entityRef, steps[] {action, status, error, at}, status | (org, workflowId, createdAt -1) |
| faqrules | keywords[], matchType, reply {text or interactive}, handoff, active | (org, active) |
| segments | name, filter (allowlisted fields: tags, state, city, source, lifecycle, ownerId, consent) | unique (org, name) |
| broadcasts | name, whatsappAccountId, template, variableMap, segmentId, scheduledAt, status, stats {total, sent, delivered, read, replied, failed}, estimatedCostPaise | (org, status, scheduledAt) |
| broadcastrecipients | broadcastId, contactId, phoneE164, variables, status, messageId, error | unique (broadcastId, contactId); (org, broadcastId, status) |
| subscriptions | planKey, status trialing/active/past_due/cancelled, trialEndsAt, currentPeriodEnd, provider refs | unique (org) |
| usagecounters | period YYYY-MM, metric, value | unique (org, period, metric) |
| apikeys | prefix, hash, scopes[], lastUsedAt, revokedAt | prefix unique global |
| webhooksubscriptions / webhookdeliveries | url, events[], encrypted secret / attempts, status, responseCode | (org, active) / (org, subscriptionId, createdAt -1) |

Plan limits live in `src/config/plans.js` (data, not logic):

| Plan | Price/mo (+GST) | Users | WA numbers | Contacts | Broadcasts/mo | Extras |
|---|---|---|---|---|---|---|
| starter | ₹999 | 2 | 1 | 3,000 | 10 | 50 templates, FAQ auto-reply, marketplace integrations |
| pro | ₹2,999 | 5 | 2 | 10,000 | 100 | + payment links, Meta Conversions API |
| growth | ₹5,999 | 10 | 2 | 40,000 | 500 | + catalog, advanced automation, API, 10,000 quotes |
| scale | ₹9,999 | 15 | 3 | 1,00,000 | 1,000 | + 25,000 quotes |

### 5.7 Relationships

- Organization 1—n Members, and 1—n every business record.
- Contact 1—n Leads, Conversations, Quotations, Orders, Tickets, Notes, Documents.
- Lead n—1 Contact; Lead n—n Products (interest); Lead 1—n Quotations; Quotation 1—0..1 Order; Order 1—n PaymentLinks.
- Conversation n—1 WhatsAppAccount; Conversation 1—n Messages and InternalNotes.
- Owner/assignee fields always reference OrganizationMember ids.
- Quotation and Order items embed product snapshots; everything else references by id.

---

## 6. API, socket events, job queues

All under `/api/v1`, authenticated and tenant-scoped unless marked **public**. Lists: `page`, `limit` (max 100), `q`, allowlisted filters and `sort`; response `{ success, data, pagination }`.

### 6.1 Endpoints by phase

**Phase 1**
- `POST /auth/google` (now returns access + refresh token; still accepts the existing flow), `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` (user + memberships + active org), `POST /auth/switch-organization`
- `GET/PATCH /organization`, `POST/DELETE /organization/logo` (unchanged paths)
- `GET /members`, `PATCH /members/:id`, `DELETE /members/:id`
- `GET/POST /invites`, `DELETE /invites/:id`, `POST /invites/:id/resend`, `GET /invites/accept/:token` (**public**, shows who invited you)
- `GET /health` (unchanged; JSON still contains `dbState`)

**Phase 2**
- CRUD: `/contacts`, `/leads`, `/products`, `/tasks`, `/events`, `/tickets`, `/documents`, `/campaigns`, `/workflows`, `/sequences`
- `GET/POST /leads/:id/activities`, `POST /leads/:id/stage` (version check), `POST /leads/:id/convert` (idempotent), `GET /leads/pipeline`
- `GET/POST /notes?parentType=&parentId=`
- `POST /documents/upload`, `GET /documents/:id/download`
- `POST /imports/localstorage?dryRun=true|false`, `GET /imports/:id`, `GET /exports/crm`
- `GET /dashboard/summary`, `GET /contacts/:id/360`
- *As built:* notes are `/tickets/:id/notes`, `/contacts/:id/notes`, `/campaigns/:id/notes` (the parent's permissions apply); uploads are `POST /documents` (multipart) and `PATCH /documents/:id`; `GET /leads/pipeline`, `GET /dashboard/summary` and `GET /contacts/:id/360` were not needed yet — the pages compute them from the loaded records (up to 5,000 per module); server-side aggregation comes with reports (Phase 9).

**Phase 3**
- `GET/POST /whatsapp/accounts`, `PATCH/DELETE /whatsapp/accounts/:id`, `POST /whatsapp/accounts/:id/test`
- `GET /webhooks/whatsapp` (**public**, verify token handshake), `POST /webhooks/whatsapp` (**public**, `X-Hub-Signature-256`)
- `GET /conversations` (filters mine/unassigned/all/open/closed, `q`), `GET /conversations/:id`, `PATCH /conversations/:id` (status, assignee, tags), `POST /conversations/:id/read`
- `GET /conversations/:id/messages` (cursor), `POST /conversations/:id/messages` (text/media/template; server enforces the 24h window; `Idempotency-Key`)
- `GET/POST /conversations/:id/notes`, `GET/POST/PATCH/DELETE /quick-replies`
- `GET /templates`, `POST /templates/sync`, `POST /templates` (submit for approval)
- `GET /whatsapp/click-to-chat` (link + QR data)
- `POST /dev/simulate/whatsapp-inbound` (dev only, 404 in production)

**Phase 4**
- `GET/POST/PATCH /lead-sources`, `POST /lead-sources/:id/test`
- `POST /webhooks/leads/indiamart/:token`, `GET|POST /webhooks/leads/justdial/:token`, `POST /webhooks/leads/facebook` (Meta signature), `POST /webhooks/leads/google-ads/:token` (`google_key` check), `POST /public/forms/:publicKey` (**public**, CORS for the org's sites, rate limit, honeypot), `GET /public/forms/:publicKey/embed.js`
- `GET/POST/PATCH/DELETE /auto-reply-rules`, `/assignment-rules`; `GET /assignment-history`
- `POST /dev/simulate/lead` (dev only)

**Phase 5**
- `GET/POST /quotations`, `GET/PATCH /quotations/:id`, `POST /quotations/:id/revise`, `POST /quotations/:id/send` (WhatsApp), `GET /quotations/:id/pdf`, `GET /q/:token` (**public**, signed view link → marks Viewed)
- `POST /pricing/preview` (server-side totals for the editor)
- `GET/POST /orders`, `GET/PATCH /orders/:id`, `POST /orders/:id/stage`

**Phase 6**: `/workflows/:id/run` (real), `/sequences/:id/enroll`, `GET /automation-runs`, `GET/POST/PATCH /faq-rules`, `PATCH /organization/business-hours`

**Phase 7**: `/tags`, `/segments`, `POST /contacts/import` (upload → mapping → preview → commit), `GET/POST /broadcasts`, `POST /broadcasts/:id/schedule|cancel`, `GET /broadcasts/:id/recipients`

**Phase 8** (as built in 8A: `/payments/connections`, `/payments/settings`, `/payment-links`, `/orders/:id/payments`, `POST /webhooks/payments/<gateway>/<key>`; see API.md): `GET /dues`, `POST /catalog/sync`

**Phase 9**: `GET /reports/agents`, `/reports/sources`, `/reports/quotations`, `/reports/broadcasts`, `/reports/payments`, `GET /reports/export?type=`

**Phase 10**: `/billing/plans`, `/billing/subscription`, `/usage`, `/api-keys`, `/outbound-webhooks`, public API under `/api/public/v1` (API-key auth, scopes), `/ai/suggest-reply`, `POST /auth/otp/request|verify`, `GET /audit-logs`, `POST /organization/export`, `DELETE /organization`

### 6.2 Socket.IO events

Handshake auth with the access token; server joins `org:<orgId>`, `user:<memberId>`, and `conv:<id>` on demand (after an access check).

| Event (server → client) | Room | Payload |
|---|---|---|
| `conversation:new` / `conversation:updated` | org (filtered by scope) | conversation summary |
| `message:new` | conv + assignee user | message |
| `message:status` | conv | `{ messageId, status, at, error? }` |
| `note:new` | conv | note |
| `lead:new` / `lead:assigned` | org / user | lead summary |
| `notification` | user | `{ type, title, body, link }` |
| `presence` | org | `{ memberId, online }` |

Client → server: `conversation:join`, `conversation:leave`, `typing` (agent-to-agent only).

### 6.3 Job queues

| Job | Trigger | Notes |
|---|---|---|
| `webhook.whatsapp.process` | inbound event stored | idempotent by message/status id |
| `wa.send` | message/template send | throttled per phone number (Meta default 80 msg/s; 1 msg per 6 s to the same user) |
| `wa.media.download` | inbound media | to storage, sha256 |
| `wa.templates.sync` | manual + daily | |
| `leadsource.indiamart.poll` | every 5 min per active connection | never faster than 5 min; window ≤ 7 days; dedupe UNIQUE_QUERY_ID |
| `leadsource.tradeindia.poll` | every N min | parameters from the seller's "My Inquiry API" page |
| `webhook.leadsource.process` | push/webhook received | normalize → Contact + Lead |
| `lead.autoreply` | lead created | must finish < 60 s end-to-end |
| `lead.assign` | lead/conversation created | atomic round-robin pointer |
| `sequence.step` | nextRunAt | stops if contact replied |
| `automation.run` | trigger events | writes AutomationRun |
| `broadcast.prepare` / `broadcast.sendBatch` | schedule | quota check, consent filter, throttled |
| `quotation.pdf` | quote created/revised | |
| `payment.webhook` | payment webhook stored | mark paid, receipt, move lead to Won |
| `payment.links.sync` | every 10 minutes | ask the gateway about open links (D42) |
| `dues.reminder` | daily | |
| `catalog.sync` | manual + daily | |
| `outbound.webhook.deliver` | domain events | signed, retries with backoff |
| `reports.rollup` | nightly | pre-aggregations for dashboards |

---

## 7. Money and GST (default rules, Phase 5)

- INR only, integer paise. Each line: `taxable = qty × unitPrice − discount`, rounded to paise; tax per line rounded to paise; totals are sums of rounded lines.
- Place of supply = customer state (first two digits of GSTIN if present, else address state). Same state as the organization → CGST + SGST, half each; when the line tax is an odd number of paise, CGST gets the lower half and SGST the rest (unit-tested); different state → IGST.
- Product prices are tax-exclusive; GST rate stored per product as a number. GST slabs were rationalized in September 2025 (5% / 18% / 40% plus special rates), so the UI suggests common rates but never hard-codes a list. **Verify the rules with a chartered accountant before Phase 5 goes live.**
- Zero-rated / exempt items: rate 0, still shown on the quotation.

---

## 8. External APIs checked (2026-09-24)

Re-check each page again right before writing that integration (rule from the brief).

| Integration | What the official docs say | Links |
|---|---|---|
| WhatsApp Cloud API | Send via `POST https://graph.facebook.com/<version>/<PHONE_NUMBER_ID>/messages`. Latest Graph API version is **v26.0** (announced 2026-07-29); keep the version in config. Webhook POSTs are signed with `X-Hub-Signature-256: sha256=<HMAC-SHA256(raw body, app secret)>`; verify on the raw body with a timing-safe compare. Webhook URL must be public HTTPS with a valid certificate (no self-signed). Throughput 80 msg/s per number by default; max 1 message every 6 s to the same user. Messaging limits apply per business portfolio for business-initiated messages (Meta has announced changes to messaging limits; check before Phase 7). | [Webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/), [Create webhook endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/), [Send messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages), [Message API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api), [Throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput), [Messaging limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits), [Upcoming limit changes](https://developers.facebook.com/documentation/business-messaging/whatsapp/upcoming-messaging-limits-changes/), [Error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes), [Graph API v26.0](https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/) |
| Meta pricing | Per-message pricing since 2025-07-01: charged when a **template** is delivered. Marketing templates always charged; utility and authentication templates free inside an open 24h customer-service window, charged outside; non-template messages are free but only allowed inside the window. Click-to-WhatsApp ads / Page buttons open a 72h free entry point window. Volume tiers lower utility/auth rates. India billing in INR launched 2026-01-01, migration deadline 2026-12-31. Third-party sites quote India rates of about ₹0.86 (marketing) and ₹0.115 (utility/authentication) per message + 18% GST, and claim service messages become chargeable from 2026-10-01; **Meta's page does not confirm that claim; verify on the official rate card before building the cost estimate (Phase 7).** | [Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) |
| Facebook Lead Ads | `leadgen` webhook gives `leadgen_id`, `page_id`, `form_id`, `ad_id`, `created_time`; fetch the lead with `GET /<LEAD_ID>`. Needs App Review with `leads_retrieval` and `pages_manage_ads`, and the Page subscribed via `/<PAGE_ID>/subscribed_apps?subscribed_fields=leadgen`. | [Leadgen webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-leadgen/), [Retrieving leads](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/retrieving), [CRM integration](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/quickstart/webhooks-integration/) |
| Google Ads lead forms | HTTP POST JSON to our URL; `user_column_data[]` with `column_id` + `string_value`; `google_key` (secret we choose) to verify the sender; ignore unknown fields. | [Overview](https://developers.google.com/google-ads/webhook/docs/overview), [Implementation](https://developers.google.com/google-ads/webhook/docs/implementation), [Samples](https://developers.google.com/google-ads/webhook/docs/samples) |
| IndiaMART | **Pull API v2**: `GET https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=…&start_time=…&end_time=…` (IST). Max 7-day window; one call per 5 minutes (429 otherwise), 5 req/min cap, violation blocks the key 15 minutes; last 365 days only; key expires if unused 7 days. Fields incl. `UNIQUE_QUERY_ID` (dedupe), `QUERY_TYPE` (W, B, P, BIZ, WA), `QUERY_TIME`, `SENDER_NAME/MOBILE/EMAIL/STATE/CITY`, `QUERY_PRODUCT_NAME`. **Push API**: IndiaMART POSTs JSON to our HTTPS URL, retries until 200, deactivates after 48h of failures, **no signature**, so the URL carries an unguessable per-org token. Both need a **paid seller** account (Push is an add-on). | [Pull API v2](https://help.indiamart.com/knowledge-base/lms-crm-integration-v2), [Push API](https://help.indiamart.com/knowledge-base/integration-of-indiamarts-lead-manager-crm-push-api-with-third-party-crms-real-time-push-of-leads) |
| JustDial | **Honest status: no public developer documentation found.** CRMs that integrate (LeadSquared, Zoho partners, Kylas, 3Sigma) give JustDial a webhook URL that **the seller's JustDial account manager** configures (reported as HTTP GET with query parameters). Plan: a tolerant per-org token URL that accepts GET or POST, logs the raw payload, maps known field names, and flags unknown formats for review. We can only finalize the mapping with a real sample from the user's account. | [LeadSquared guide (third-party)](https://help.leadsquared.com/integrate-justdial-with-leadsquared/) |
| TradeIndia | **Honest status: no public API docs.** Paid sellers see "My Inquiry API" under My Profile → Inquiries & Contacts, which shows an API link plus `userid`, `profile_id` and `key`; CRMs poll it. Exact parameters and limits must be read from the user's own account page in Phase 4. | [TradeIndia help: My Inquiries](https://www.tradeindia.com/about-us/help/my-tradeindia/my-inquiries/), [Kylas guide (third-party)](https://support.kylas.io/portal/en/kb/articles/how-to-integrate-kylas-crm-with-your-trade-india-account-to-capture-leads) |
| Razorpay | Payment Links API; `payment_link.paid` (and related) webhook events; `X-Razorpay-Signature` = HMAC-SHA256(raw body, webhook secret). | [Payment Links API](https://razorpay.com/docs/api/payments/payment-links/), [Payment Link webhooks](https://razorpay.com/docs/webhooks/payment-links/), [Validate webhooks](https://razorpay.com/docs/webhooks/validate-test/) |
| Cashfree | Payment Link webhooks for paid / partially paid / cancelled / expired; `x-webhook-signature` = base64(HMAC-SHA256(`x-webhook-timestamp` + raw body, client secret)). | [Payment Link webhooks](https://www.cashfree.com/docs/api-reference/payments/latest/payment-links/webhooks), [Webhooks overview](https://www.cashfree.com/docs/payments/online/webhooks/overview) |
| Job queue options | Agenda 6.x (TypeScript rewrite, pluggable backends incl. MongoDB) fits "a few thousand jobs/minute"; BullMQ on Redis is faster and has built-in rate limiting. Redis has no native Windows build; Memurai Developer Edition is the Redis-compatible option for local Windows development (not licensed for production). | [Agenda](https://www.npmjs.com/package/agenda), [BullMQ](https://docs.bullmq.io), [Memurai](https://www.memurai.com/get-memurai) |

---

## 9. Decisions

### 9.1 Section 5 defaults (proposed; used unless you override)

| # | Topic | Default |
|---|---|---|
| D1 | Money | INR only; integer paise; round each line to 2 decimals |
| D2 | GST | Tax-exclusive prices; place of supply = customer state (GSTIN state code, else address); same state → CGST+SGST, else IGST; products get hsnSac, unit, moq, images |
| D3 | Contact model | One Contact per E.164 phone (default +91), unique per org when a phone is given (phone stays optional, like the current forms); optional email, company, GSTIN, state, city, tags, source, owner, lifecycle lead/customer; everything references contactId; migrate customers + leads; legacy Accounts merge into `Contact.company`; "Account Champions" stays the team page |
| D4 | Lead stages | New → Contacted → Quote Sent → Negotiation → Won / Lost (Lost needs a reason); map In Progress → Contacted, Qualified/Proposal → Quote Sent; per-org configurable later |
| D5 | Lead sources | WhatsApp, IndiaMART, JustDial, TradeIndia, Facebook, Google Ads, Website, Manual, Import |
| D6 | Quotations | Types Quotation / Estimate / Proforma Invoice; Draft → Sent → Viewed → Accepted / Rejected / Expired; numbers per financial year (April–March) e.g. `QT/2026-27/0001` from an atomic counter; revisions kept |
| D7 | Orders | Received → Processing → Dispatched → Delivered → Payment Collected, plus Cancelled; stock informational, optional "reduce stock on Dispatched" |
| D8 | Inbox | Conversation status Open / Pending / Closed; server enforces the 24h window (outside it only approved templates) |
| D9 | Consent | Stored per contact; STOP or UNSUBSCRIBE opts the contact out of marketing broadcasts |

### 9.2 New decisions found in this audit

| # | Decision | Recommendation | When |
|---|---|---|---|
| D10 | Background jobs: Agenda on MongoDB vs BullMQ + Redis | **Jobs in MongoDB, behind a small queue interface** so BullMQ can replace it later. Reasons: runs on the Atlas cluster you already have, no Redis to install on Windows or pay for in production, and our volume (auto-replies, 5-minute polls, SMB broadcasts) is small. Switch to BullMQ when broadcast volume or throughput needs it; only the driver changes. | **Decided 2026-09-24: Agenda on MongoDB. Revised 2026-09-29: our own small MongoDB queue (`src/jobs`)** — Agenda 6 is ESM-only (the tests would need an experimental Node flag) and brings two packages; the in-house queue covers what we need (atomic claim, retries, recurring jobs, unique keys) |
| D11 | Where to commit | **Use the existing repo inside `OriginalCrm - Copy/`** (already on GitHub as RealCrm, history intact). In Phase 1: add a root `.gitignore`, stop tracking the stray root `node_modules/`, one branch per phase. Leave the outer folder's repo alone. | **Decided 2026-09-24: inner RealCrm repo** |
| D12 | One user in many organizations? | **Membership model; a user can belong to several orgs; the token carries the active org; a simple org switcher in the user menu.** First login creates an org only when there is no pending invite for that email. | **Decided 2026-09-24: multi-org with switcher** |
| D13 | Leads vs Deals | **One pipeline.** A Lead is the opportunity; the Deals page becomes the Kanban view of Leads using the D4 stages. Old deals are imported as leads (Lead → New, Qualified/Proposal → Quote Sent, Negotiation, Won, Lost). Avoids building a second pipeline in Phase 2 and matches BizNuma. | **Decided 2026-09-24: one pipeline** |
| D14 | Company field names | `gstin`, `stateCode` (derived from GSTIN), `postalCode`, `size` (kept, it is a range), `foundedYear`; migrate `gst`, `pincode`, `founded`; app.js review uses the same names. | Default unless you object |
| D15 | Brand | "YELLOW CRM" everywhere (login.html currently says "ONE CORE CRM"). | Default unless you object |
| D16 | SVG logos | Keep SVG, serve `/uploads` with `Content-Security-Policy: sandbox` + `nosniff`. | Default (engineering) |
| D17 | Agent visibility | Agents see assigned records only; admins can grant `view_all` per module. (From the brief; also closes BACKEND-AUDIT-SPEC decision 10.) | Default |
| D18 | Production hosting | **Render**: one web service in Singapore built from GitHub `main` (`render.yaml`, plan 1c-2g, a 5 GB disk for logos, documents and media), MongoDB Atlas as today. Same `JWT_SECRET` and `GMAIL_TOKEN_ENCRYPTION_KEY` as the computer so saved tokens and quotation links keep working; a new `DATA_ENCRYPTION_KEY`. The computer's server stops using the live database once Render runs. Steps: docs/RENDER_SETUP.md. | Decided 2026-10-08 by you |
| D22 | WhatsApp webhook URL | One callback URL per connected number (`/api/v1/webhooks/whatsapp/<random key>`) with its own verify token and app secret, instead of one shared URL: each company can use its own Meta app, and the signature is checked before the payload is read. | Decided in Phase 3A (engineering) |
| D23 | Background jobs in Phase 3 | Webhook items are stored first and processed in-process with a retry loop; Agenda (D10) is added when polling and broadcasts need scheduled jobs (Phase 4). | Decided in Phase 3A (engineering) |
| D24 | Which chats an agent sees | Chats assigned to them **and** chats nobody has taken yet (a shared queue); `inbox:view_all` sees all. The first reply assigns an unassigned chat to the sender. | Decided 2026-09-28 (recommended option a) |
| D25 | Who owns a WhatsApp customer | Whoever the chat is assigned to (by hand, by the first reply, or by starting the chat from a contact) becomes the owner of its contact and open leads **if nobody owns them yet**; a teammate's records are never taken. Phase 4 assignment rules will set the owner first. | Decided 2026-09-29 (recommended option) |
| D26 | A repeat enquiry from someone with an open lead | Added to that open lead (an "Enquiry" activity; its follow-up moves to now) instead of a second lead; the same source enquiry is never taken twice; once the lead is Won or Lost the next enquiry is a new lead. | Decided 2026-09-29 (recommended option) |
| D27 | Quotation PDF | The pdfkit library (Rupee sign with an embedded font, tables, logo, UPI QR) instead of a hand-written PDF. | Decided 2026-09-29 (recommended option) |
| D28 | Grand total rounding | Rounded to the nearest rupee with a "Round off" line (on by default; Settings → Billing can turn it off); each line and tax is rounded to the paisa. | Decided 2026-09-29 (recommended option) |
| D29 | Quotations from the lead form | The Phase 2 inline quote items in the lead form move to the Quotations page; the lead form keeps product, quantity and price and gets a "Create quotation" button. | Decided 2026-09-29 (recommended option) |
| D30 | Customer's state unknown | Assume the organization's own state (CGST + SGST) and show a warning in the editor; typing the state or GSTIN re-prices at once. | Decided 2026-09-29 (recommended option) |
| D31 | "Notify agent" | A notification under a bell in the CRM's top bar on every page (live for members with the Inbox open, otherwise within a minute); no email or browser push yet. | Decided 2026-10-03 (recommended option) |
| D32 | Phase 2 workflows and sequences | Moved into the new engine **paused**, with notes on what could not be carried over, so nothing starts messaging customers before a person checks it. | Decided 2026-10-03 (recommended option) |
| D33 | When the FAQ bot answers | Only while no agent has taken the chat (and until the customer asks for a person). | Decided 2026-10-03 (recommended option) |
| D35 | Who gets WhatsApp offers | Everyone who has not opted out. A message that is only STOP / UNSUBSCRIBE (or the "Stop promotions" button) opts the customer out, with a confirmation; START opts them back in. The customer form and CSV import ("they agreed") can mark them; an import never overrides an opt-out. | Decided 2026-10-05 (recommended default; you said "continue") |
| D34 | Plan limits before billing | Until billing arrives (Phase 10) every organization is on the free trial with the Growth limits (500 broadcasts a month, 40,000 contacts …); the plans are data in `constants/plans.js`. | Decided 2026-10-05 (recommended default) |
| D37 | Broadcast cost estimate | Meta's per-message rates for India by template category, kept as data with their date (₹0.8631 marketing, ₹0.115 utility/authentication, + 18% GST, as published for October 2026); an estimate only. Meta's own rate card is an interactive page, so please check the rates against your first Meta invoice. | Decided 2026-10-05 (recommended default) |
| D38 | Sending pace | Batches of 20 a second (well under Meta's throughput) and never more different people a day than the number's Meta tier (the rest waits for room). | Decided 2026-10-05 (recommended default) |
| D36 | Who manages segments and broadcasts | Owners and admins, like assignment and auto-reply rules (they write to many customers at once). | Decided 2026-10-05 (recommended default) |
| D39 | Payment webhook address | One address per gateway connection (`/api/v1/webhooks/payments/<gateway>/<random key>`), like D22: each company uses its own Razorpay/Cashfree account and the signature is checked with that connection's secret before the body is read. | Decided 2026-10-05 (recommended default) |
| D40 | What a payment does | The first payment received wins the lead (an advance confirms the deal); the order is "paid" when the payments cover its total; a link for a quotation accepts it and makes the order; paid in full, a Delivered order moves on to Payment Collected (earlier stages stay, with "Paid"). Payments by cash or bank transfer are entered on the order. | Decided 2026-10-05 (recommended default) |
| D41 | Payment receipt | A WhatsApp text inside the customer's 24-hour window, else the approved receipt template chosen in Settings → Payments, else none (the bell says why). Can be turned off. | Decided 2026-10-05 (recommended default) |
| D42 | Without a public address | Besides webhooks, open links are checked with the gateway every 10 minutes and with "Check now", so payments arrive even when the CRM runs on this computer. | Decided 2026-10-05 (recommended default) |
| D43 | Catalog prices | Products go to the Meta catalog with the price including GST (what the customer pays); orders from the catalog are priced from the products as usual. | Decided 2026-10-05 (recommended default; used in 8C) |
| D44 | Orders from the WhatsApp catalog | A cart becomes an order at Received, priced from the CRM's products (GST as usual); an item the CRM does not know goes in at the cart's price without GST and the order shows a warning (also when the catalog price differed); the customer gets a thank-you and the order's owner (else owners and admins) a bell note. | Decided 2026-10-07 (recommended default) |
| D45 | Who sees which report figures | Owners, admins and members with "reports: see all" see the whole company; everyone else (with the Reports module) sees their own leads, quotations, orders, chats and work. Broadcast figures stay with owners and admins (D36). | Decided 2026-10-07 (recommended default) |
| D46 | Response time | From a customer's first unanswered message to a teammate's reply; the FAQ bot, auto-replies and broadcasts do not count as an answer. Clock time (not only working hours); "first response" for chats that started in the period. Median and average shown. | Decided 2026-10-07 (recommended default) |
| D47 | How reports are counted | From the records when a report is opened, for days in India time; no nightly rollup yet (fast enough at today's sizes; rollups can be added if it gets slow). | Decided 2026-10-07 (recommended default) |
| D48 | Trial and existing companies | New companies try the Growth plan free for 30 days; companies from before billing are complimentary (keep their plan, no end), so a CRM in use never locks. Quotations a month for Starter and Pro (not in the brief): 300 and 2,000, editable in `constants/plans.js`. Workflows are the "advanced automation" of Growth; follow-up sequences, the FAQ bot and auto-replies are in every plan. | Decided 2026-10-07 (recommended default) |
| D49 | After the trial, or a failed or ended plan | Nothing is deleted. Signing in, reading, replying to customers, receiving WhatsApp messages and leads (with auto-assign, the FAQ bot, auto-replies, running workflows and sequences) and recording payments keep working. Adding users, numbers, contacts, templates, quotations and broadcasts, and the paid features, wait for a plan. Above a smaller plan's limits, nothing is removed but nothing more can be added. "Payment due" (Razorpay retrying) still works. | Decided 2026-10-07 (recommended default) |
| D50 | How the plans are paid | Razorpay Subscriptions on the platform's own account, monthly, the plan price + 18% GST; a GST tax invoice from the platform (`BILLING_SELLER_*`, SAC 998315 by default — confirm with your CA) for each charge, numbered per financial year. Choosing during the trial keeps the rest of it free. Upgrades now, downgrades from the next month. | Decided 2026-10-07 (recommended default) |
| D51 | Who an API key acts as | The owner or admin who made it, for the whole company, within the ticked scopes; it stops when revoked, when that person is no longer an owner or admin, or when the plan has no API. Only a SHA-256 of the key is kept; it is shown once. 120 requests a minute per key. Leads sent through the API are handled like a lead source (dedupe, open lead gets the enquiry, rules run) and never stopped by the contact limit. | Decided 2026-10-07 (recommended default) |
| D52 | Outbound webhook delivery | Public https only; HMAC-SHA256 of the raw body with each webhook's own secret; a stable event id for dedupe; retries after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h and 24 h; switched off after 25 failed deliveries in a row (bell note); a 30-day delivery log. Contacts from CSV imports do not send contact.created (a big file would flood the receiver). | Decided 2026-10-07 (recommended default) |
| D53 | Meta Conversions API | Lead stages as "conversion leads" events (stage name = event name) for Lead Ads leads with Meta's lead id; leads from other sources only when "all sources" is ticked (matched by SHA-256 phone and email). Only ticked stages; events older than 7 days are not sent. | Decided 2026-10-07 (recommended default) |
| D54 | The AI assistant | Opt-in per company (off by default), on the platform's Claude API key with a monthly budget per company (AI_MONTHLY_BUDGET_USD, $5 by default, estimated from list prices). Suggestions for agents use Sonnet 5.5 at low effort; answers by itself (a second switch) use Haiku 4.5, only for text messages the FAQ bot did not answer, in chats no teammate wrote in for 30 minutes, under 15 minutes old, and only when sure; otherwise the chat is handed to a person and the assistant stays quiet there for a day. Grounded only in the company's own facts. Paused while the plan is not active. Customer messages and products go to Anthropic (the settings page says so). | Decided 2026-10-07 (recommended default) |
| D55 | Phone sign-in | Next to Google, not instead of it: a member verifies their own number once while signed in, then can sign in with a 6-digit WhatsApp code from the platform's number (authentication template). Codes HMAC-stored, 5 minutes, 5 tries, one use, 3 per number per 15 minutes; the login page never tells whether a number is in use. No new accounts by phone. | Decided 2026-10-07 (recommended default) |
| D56 | Mobile app and notifications | An installable web app (PWA) rather than a store app; every bell note also goes as web push to the devices each member switched on. Pages, scripts and styles are fetched fresh when online (the last copy is kept for offline), the API is never cached. iPhones need the app added to the home screen for push (iOS 16.4+). | Decided 2026-10-07 (recommended default) |
| D57 | Deleting a company | Only an owner, typing the company name; it keeps working for 7 days (ORG_DELETION_GRACE_DAYS) with a banner on every page, and any owner can keep it. Then every record with its organizationId, its files and logo are removed and its paid plan stops. Kept: the platform's GST invoices (tax law) and people's sign-in accounts (they may belong to other companies). | Decided 2026-10-08 (recommended default) |
| D19 | Atlas tier | Free tier is fine for development; production messaging volume needs a paid tier (storage and ops limits). | Before launch |

The remaining items in `docs/DECISIONS_REQUIRED.md` are answered by D1–D17 (Account → D3, pricing/tax → D1/D2, inventory → D7, org fields → D14, email uniqueness → phone is the unique key per D3, pipeline → D4/D13, quotation lifecycle → D6, ticket SLA → basic CRUD for now, document storage → local now / S3-R2 later, permissions → D17, duplicates → phone + source ref, simulated features → real in Phase 6, AI → Phase 10 add-on). Phase 1 updates that file.

---

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Meta business verification, number registration and template approval take days to weeks | Phase 3 cannot be tested with real WhatsApp | MockProvider + simulator; start Meta setup early (section 12) |
| New numbers start with low business-initiated messaging limits; quality rating can drop | Broadcasts/auto-replies throttled or blocked | Honour limits, show quality rating, opt-out handling, warm-up guidance |
| Meta pricing changes (per-message model, India INR billing, unconfirmed Oct-2026 service-message change) | Wrong cost estimates | Rates as data, verify rate card before Phase 7 |
| IndiaMART key is paid, expires after 7 unused days, 5-minute call rule blocks the key | Missed leads | Scheduler never polls faster than 5 min; overlap windows + UNIQUE_QUERY_ID dedupe; alert when the key fails |
| JustDial/TradeIndia have no public docs | Integrations may not be possible or may break silently | Tolerant endpoints, raw payload log, "unknown format" alerts; honest status in Settings |
| Browser data lives per address; migration could lose data | Data missing after switching address or before Phase 2 import | Export/import steps now (2.2 #9); Phase 2 importer with preview and report; never delete browser data automatically |
| Google sign-in on the new address not yet confirmed | Nobody can log in at 127.0.0.1:3000 | Add the origin in Google Cloud Console; Live Server path keeps working meanwhile |
| Untrusted content (WhatsApp, lead sources) rendered with innerHTML | XSS, token theft from localStorage | textContent/escapeHtml only; CSP for app pages in Phase 1; consider moving tokens out of localStorage |
| Phone normalization edge cases (+91, landlines, missing digits) | Duplicate contacts | libphonenumber-style normalizer with tests; manual merge tool later |
| GST correctness (slab changes, place of supply, rounding) | Wrong invoices | Pure-function pricing module with unit tests; CA review |
| The full test suite runs in parallel against one in-memory MongoDB | On a busy machine (right after stopping the E2E server, or with the CRM server and OneDrive busy) many suites time out | Re-run, or run serially with `npx jest --runInBand` (about 5 minutes); a failure that stays when run alone is a real one |
| India's DPDP Act 2023 and its rules (consent, access, deletion) | Compliance exposure for a SaaS | Consent per contact, data export and org deletion (Phase 10); verify current obligations before launch |
| Automations act for real (messages, stage changes) and run on the server that is running | A mistake reaches many customers; the live CRM server (nodemon on the checked-out branch) runs workflows against Atlas | Old workflows come over paused (D32); refused steps fail the run at once; loop guard; Stop and Pause; test runs on one lead; run log shows every step |
| Windows local dev (no Docker, Redis) | Friction for you | D10 recommendation avoids Redis; start-crm.vbs and the VS Code task keep working |
| Scope size (10 phases) | Long timeline | Strict phase gates; each phase ends in a working, tested state |

---

## 11. Local development notes

**MongoDB transactions.** Atlas is a replica set, so transactions work with the current `MONGO_URI`. For a local MongoDB instead:

```bash
mongod --replSet rs0 --dbpath C:\data\rs0 --port 27017
mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})"
```

Then `MONGO_URI=mongodb://127.0.0.1:27017/crm?replicaSet=rs0`. Tests use `MongoMemoryReplSet` and never touch Atlas.

**Public HTTPS for webhooks (Meta, IndiaMART push, payments).** Meta needs a public HTTPS URL; your laptop is not public. A tunnel gives a temporary public address that forwards to `http://127.0.0.1:3000`:

- cloudflared: `cloudflared tunnel --url http://127.0.0.1:3000` prints a `https://<random>.trycloudflare.com` address. It changes every run; a named Cloudflare tunnel with your own domain keeps it fixed.
- ngrok: `ngrok http 3000` (free plan gives one static domain).

Use `<tunnel-url>/api/v1/webhooks/whatsapp` as the callback URL in the Meta app. Phase 3 will walk through this step by step.

---

## 12. Things you set up yourself (and when)

| When | What |
|---|---|
| Now | Confirm Google sign-in at `http://127.0.0.1:3000` (add it to "Authorized JavaScript origins" if Google shows `origin_mismatch`); move browser data from the old address (Export → Import) |
| Before Phase 3 | Meta Developer app, WhatsApp Business Account, business verification, a phone number not active on the WhatsApp app, a permanent System User token, the app secret, a webhook verify token of your choice |
| Before Phase 4 | IndiaMART paid seller account + CRM API key (and Push API add-on if wanted); JustDial account manager contact; TradeIndia "My Inquiry API" details; Facebook Page + ad account for Lead Ads; Google Ads account for lead forms |
| Before Phase 8 | Razorpay and/or Cashfree accounts, API keys (test first), webhook secrets |
| Before selling plans | Razorpay Subscriptions on your own account (test keys first), the billing webhook, your GST details for the invoices (docs/BILLING_SETUP.md) |
| Before offering the AI assistant | A Claude API key on your Anthropic account with a spending limit (docs/AI_ASSISTANT.md); mention it in your privacy notice |
| Before offering phone sign-in | A WhatsApp number of the platform and an approved authentication template (docs/WHATSAPP_SETUP.md) |
| Before launch | A Render account and the Blueprint (docs/RENDER_SETUP.md), paid Atlas tier (D19), backups, `npm audit` — docs/DEPLOYMENT.md |

---

## 13. Effort estimate

Rough engineering days (AI-assisted), plus the number of working sessions. External waiting time (Meta verification, IndiaMART key, payment KYC) is extra.

| Phase | Days | Sessions | Main cost |
|---|---|---|---|
| 1 Foundation | 3–5 | 2–3 | Auth rotation, membership migration, test infra |
| 2 Core CRM to server | 8–12 | 5–7 | 17 pages move off localStorage; importer |
| 3 WhatsApp inbox | 8–10 | 4–6 | Webhooks, 24h rule, realtime inbox UI |
| 4 Lead sources + routing | 5–7 | 3–4 | Five sources, rules engine, 60 s SLA |
| 5 Pipeline, GST quotes, orders | 6–8 | 3–5 | Pricing module, PDF, revisions |
| 6 Automation + FAQ bot | 6–8 | 3–5 | Trigger/action engine, sequences |
| 7 Broadcasts | 4–6 | 2–3 | Import, segments, throttling, stats |
| 8 Payments + catalog | 5–7 | 3–4 | Two gateways, catalog sync |
| 9 Reports | 3–5 | 2–3 | Aggregations, exports |
| 10 SaaS + extras | 10–15 | 6–8 | Billing, public API, PWA, OTP, AI |
| **Total** | **58–83** | **33–48** | |

---

## 14. Changelog

- **2026-10-08 — Merged and pushed; hosting decided (D18).** All ten phases are on `main` and on GitHub. Hosting is Render: `render.yaml` describes the service (Singapore, a disk for files, the settings to fill in) and docs/RENDER_SETUP.md walks through the account, Atlas access, Google sign-in, the webhook addresses and switching on the optional features.

- **2026-10-08 — Phase 10, checkpoints F and G (admin, deployment, acceptance) — Phase 10 done.** Owners and admins see an audit log of who did what (Settings → Audit log). "Download CRM data" now holds every part of the CRM, still without passwords, keys or tokens. An owner can delete the company: it keeps working for 7 days with a warning on every page and can be kept; then all its data and files are removed (the platform's tax invoices stay). A command for the platform owner lists every company's plan and can comp one, extend a trial or change a plan. docs/DEPLOYMENT.md explains HTTPS, Atlas, keeping the server running, backups, logs and security. One end-to-end test follows a company from sign-up to deletion; run three times in a row. 471 tests, all passing.

- **2026-10-07 — Phase 10, checkpoint E (mobile app, push, phone sign-in).** The CRM can be installed on a phone or computer like an app (an offline notice when there is no internet), and every bell note — a new chat, a lead, a payment, a hand-off — can also arrive as a phone or desktop notification, switched on per device in Settings → Your Profile. People can sign in with a 6-digit code on WhatsApp, next to Google, after they verify their number once. 464 tests, all passing.

- **2026-10-07 — Phase 10, checkpoint D (AI assistant).** An optional AI assistant on Anthropic's Claude API (the official SDK, added with your OK). In the Inbox, "Suggest a reply" drafts 1–3 answers from the company's products, prices and FAQ for the agent to check and send. With a second switch it answers customers on WhatsApp by itself, only when it is sure and nobody from the team is in the chat; otherwise it passes the chat to a person with a bell note. Every call is logged with its tokens and estimated cost; each company has a monthly budget. Settings → AI assistant has the switches, the company's instructions, the month's use and a test box. Guide: docs/AI_ASSISTANT.md. 450 tests, all passing.

- **2026-10-07 — Phase 10, checkpoint C (API, webhooks, Conversions API).** Companies on Growth and up can connect their own software, Zapier or Make: API keys with ticked permissions (shown once, revocable) for a public REST API to read and add customers and leads (an API lead is handled like any enquiry, with assignment and auto-reply), read quotations, orders and products, and send approved WhatsApp templates; webhooks that tell an https address about new leads, stage changes, new customers, WhatsApp messages, quotation and order changes and payments, signed, retried for a day, with a delivery log. Pro and up can send lead stages to Meta's Conversions API so Lead Ads optimise for leads that become customers. Settings → API & webhooks; guide: docs/INTEGRATIONS.md. 443 tests, all passing.

- **2026-10-07 — Phase 10, checkpoint B (paying for the plan).** Companies pay for their plan through Razorpay Subscriptions on the platform's own account: Choose opens Razorpay's page (during the trial only the mandate is set up and the first charge waits for the trial's end), upgrades start at once and downgrades with the next month, Cancel keeps the plan until the paid month ends, and Check now (also every 6 hours) finds payments when webhooks cannot reach the CRM. Each monthly charge gets a GST tax invoice (CGST + SGST in the same state, else IGST) with a PDF in Settings → Plan & usage. A failed payment shows "Payment due" while Razorpay retries; when every retry fails the plan is halted and adding things waits. Owners and admins get bell notes for the trial (7, 3, 1 days, ended), the plan and each payment. Development has a test gateway with its own checkout page. Guide: docs/BILLING_SETUP.md. 427 tests, all passing.
- **2026-10-07 — Phase 10, checkpoint A (plans, limits, trial).** The four plans are data; what a company uses is counted from its records. New companies get a 30-day Growth trial; existing ones are complimentary (migration 005). Adding users (pending invites count), WhatsApp numbers, contacts by hand or import (a file that does not fit is refused whole), templates, quotations and broadcasts stops at the plan's limit with a message and a "See plans" prompt; workflows, payment links and the catalog need their plan. Customers who write on WhatsApp and leads from lead sources are always added. After the trial without a plan, everything can be read and chats keep working, but adding things waits for a plan. Settings → Plan & usage shows the plan, the usage meters and the plans with GST; a banner shows the last 7 days of the trial.

- **2026-10-07 — Phase 9, checkpoint C (AI Insights, acceptance) — Phase 9 done.** AI Insights now reads the server's numbers: the weighted pipeline forecast, open opportunities, leads that need attention, the 90-day win rate, recommended actions (customers waiting for a reply, leads in Negotiation, idle leads, money due for over a month, leads without an owner, each with a link), the pipeline by stage, the leads worth most with a next step, and a briefing; "Ask" answers from the same numbers (it does not call a language model; the optional Claude assistant is Phase 10). One end-to-end test (the brief's test 5) runs from WhatsApp messages to the admin's agent performance report. Run three times in a row. 412 tests, all passing.

- **2026-10-07 — Phase 9, checkpoint B (Reports page and dashboard).** Reports & Analytics now shows the server's numbers for one period that every chart follows: today, the last 7/30/90 days, this or last month, this financial year, the last 12 months, or any two dates (remembered). Panels that show the present (open pipeline, what is due) say "now". New tabs: WhatsApp & Team (reply times, chats answered, leads, quotations, orders and money per person) and Payments (collected over time, how customers paid, payment links, dues by age); Sales shows the quotation funnel, win rate and why quotations are rejected; Leads & Marketing shows where leads come from, how far they get, and broadcast delivery, read and reply rates. Export CSV downloads the open tab. The dashboard's cards now come from the server: chats waiting for a reply, new leads today, open pipeline, quotations waiting three days, collected this month, due now and tasks due today.

- **2026-10-07 — Phase 9, checkpoint A (reports API).** The server now counts the reports for any range of days (India time): an overview, a trend by day, week or month, agent performance (first and average response time on WhatsApp, chats handled, leads by stage, won, quotations, orders, money collected, tasks and tickets), where leads come from and how far they get, how many quotations are won and why others are lost, broadcast delivery, read and reply rates, and payment collection with dues by age; also the dashboard's numbers and the insights for the AI Insights page. Every report downloads as a CSV file that opens in Excel. Owners and admins see the company, others their own figures. No new library; one new index on messages.

- **2026-10-07 — Phase 8, checkpoint D (acceptance) — Phase 8 done.** One end-to-end test (the brief's test 3) runs the whole path through the real code with Meta and Razorpay faked: a WhatsApp enquiry, the agent's reply, the GST quotation PDF in the chat, the payment link in the chat, Razorpay's signed webhook, the order made and paid, the lead won, the receipt and the bell; then a catalog cart that becomes an order and is paid in two parts (one by webhook, one found by checking the link), and an empty dues list. Run three times in a row. 404 tests, all passing.

- **2026-10-07 — Phase 8, checkpoint C (WhatsApp catalog).** Settings → WhatsApp connects the Meta Commerce catalog of a number (checked with Meta; it can switch on the shop button and the cart). On the Products page a product gets a photo link, an SKU and "Show in the WhatsApp catalog"; the CRM sends those products to Meta at once, every day and with "Sync now" (prices with GST, D43), removes the ones taken out, and shows which need attention (no photo, no price, Meta refused). In the Inbox the store button sends one product or a list of up to 30 grouped by category. A cart the customer sends back becomes an order at Received (D44): priced from the products, the customer's note kept, unknown items flagged; the customer gets a thank-you, the team a bell note, and the chat links the order. The simulator can send a cart. 403 below the Growth plan.

- **2026-10-07 — Phase 8, checkpoint B (payment links on the pages, dues, reminders).** A "Payment link" dialog on orders, quotations and the Inbox contact panel makes the link (what is due is filled in, part payments and validity optional) and sends it into the customer's WhatsApp chat — a ready message within 24 hours of their last message, else an approved template — or copies it; it shows the open link with "Check now" and "Cancel". Orders show what is paid and due, every payment, "Record payment" for cash, cheque or bank transfer (which cancels an unused link once the order is paid), a Payment column and a "Payment due" tab with totals by age (0–7, 8–30, 31–60, 60+ days). Settings → Payments connects Razorpay, Cashfree or the test gateway, shows the webhook address and which events to tick, and picks the templates for links and receipts. Sales Automation has the trigger "An order is still not paid after some days" and the step "Send the order's payment link" (also in sequences), plus {{order.paid}} and {{order.due}}. Receipts and broadcasts are labelled in the chat. docs/PAYMENTS_SETUP.md explains the keys and webhooks step by step.

- **2026-10-05 — Phase 8, checkpoint A (payment links, API).** Settings can hold the organization's own Razorpay and Cashfree keys (checked with the gateway, kept encrypted, never shown again), each with its own webhook address; a test gateway works without keys in development. A payment link can be made for an order (what is still due), a quotation (its total) or any amount for a customer, with part payments and an expiry; only one open link per order or quotation. Payments arrive by the gateway's signed webhook and by a check of open links every 10 minutes, and each is counted once: it goes on the order, accepts the quotation and makes its order, wins the lead, moves a delivered order to Payment Collected when paid in full, sends the customer a receipt on WhatsApp and rings the bell. Cash and bank transfers can be entered on the order. No new library; no migration (payment status is worked out from the payments).

- **2026-10-05 — Phase 7, checkpoint D (acceptance) — Phase 7 done.** One end-to-end test (the brief's test 4) runs it all through the real code with Meta faked: a CSV import of customers who agreed to offers, an opt-out by a WhatsApp STOP, the "Tier A – Rajasthan" segment, a marketing broadcast with each customer's name, a number WhatsApp refuses, delivery and read reports and a reply by signed webhooks, the stats and the monthly quota the admin sees, Meta's daily limit read from Meta — and nothing for an agent or another company. Run three times in a row to check it is steady. 388 tests, all passing.

- **2026-10-05 — Phase 7, checkpoint C (Marketing page).** Marketing now has three tabs for owners and admins: Campaigns (as before), WhatsApp broadcasts and Segments. Segments: name it, choose tags, states, cities, product categories, customers or leads, source, lead stage and whether only people who agreed should be in it; the count and some names update as you choose. Broadcasts: name, approved template, what fills each {{1}}, the segment; "Save draft" shows how many will get it, the estimated Meta cost, today's room in Meta's limit and the broadcasts left this month; then "Send" now or at a chosen time. The results show recipients → sent → delivered → read → replied (with percentages), failed and skipped, and every customer with their status, reason and a link to the chat; they refresh while sending, and the bell note when it finishes opens them.

- **2026-10-05 — Phase 7, checkpoint B (broadcast engine).** WhatsApp broadcasts: an approved template, filled in for each customer (their name, company …, or fixed words), sent to a segment now or at a set time. Starting fixes the list — customers with a mobile number who have not opted out — and sends 20 a second, never to more different people a day than Meta's limit for the number (the rest waits). Each customer's message lands in their chat; WhatsApp's reports mark them delivered, read or failed, and a reply within 7 days counts as replied; someone who opts out meanwhile, or lacks a value for the template, is skipped with the reason. Pause, resume and cancel; a bell note when it finishes. Before sending: how many it reaches, the estimated Meta cost (₹ by template category, + GST; D37) and the plan's broadcasts left this month (trial = Growth, 500; D34). The number's Meta limit is read when it is checked.

- **2026-10-05 — Phase 7, checkpoint A (consent, segments, CSV import).** Customers now carry their WhatsApp-offers choice: set on the customer form ("Not asked yet / Agreed / Said no"), or by the customer — a WhatsApp reply of just STOP (or UNSUBSCRIBE, or Meta's "Stop promotions" button) opts them out with a confirmation message and a note on their lead, START opts them back in (D35); marketing templates and broadcasts skip them. The customer form also has city, state and tags (shown in the list and searchable). Segments (owners and admins, D36) save an audience by tags (all / any / none), state, city, source, customer or lead, owner, product or product category, lead stage; a preview says how many it reaches, how many have WhatsApp and how many were left out for having opted out. Customers → Import CSV: the columns are guessed from their names ("Mobile No", "Party Name", "GST No" …) and can be changed, numbers get +91, repeats in the file merge, people already in the CRM get their missing details and the tags, a "Check first" run shows the result without saving, and rows that cannot be used are listed with their row number.

- **2026-10-03 — Phase 6, checkpoint D (acceptance) — Phase 6 done.** One end-to-end test runs the automation features together through the real code (job worker, automation engine, sequences, FAQ bot, the WhatsApp Cloud API sender with Meta faked, signed webhooks, live sockets): an IndiaMART enquiry assigned and followed up by a workflow and a sequence until the customer replies, a new WhatsApp customer served by the bot's list until they ask for a person, a reminder task after a day without a reply, the run log and backup, and nothing for another company. The same path was run in the browser (the Inbox now hides the bot switch in chats someone has, where the bot is quiet anyway). 370 tests, all passing.

- **2026-10-03 — Phase 6, checkpoint C (WhatsApp FAQ bot).** Sales Automation → FAQ bot (owners and admins): turn the bot on, write a greeting (with options, e.g. "Price list" / "Talk to a person"), an away message for outside working hours, and answers that come when a message has one of their words — English or Hindi ("rate", "दाम"), whole words only. An answer can have up to 10 options: 1–3 appear as WhatsApp buttons, 4–10 as a list; each opens another answer or hands the chat to a person. The bot only answers while nobody from the team has the chat (D33): when the customer asks for a person (by a word like "agent" / "baat karni hai" or the button), it says so, stops in that chat and rings the bell of the customer's owner; a teammate's reply also takes the chat from it. In the Inbox each chat shows "Bot answering" / "Bot off" with a switch, and bot messages show their buttons. Closing a chat lets the bot answer that customer again. With the greeting on, auto-reply rules no longer also greet people who write on WhatsApp. Built from Meta's Cloud API reference for reply-button and list messages. 369 tests, all passing.

- **2026-10-03 — Phase 6, checkpoint B (sequences per customer).** Sequences are now real follow-ups: steps on day 0, 2, 5 … after a customer is added (WhatsApp template or message, task, notification, tag, stage, give the lead to someone), sent only in working hours if you want (a step due at night waits for the morning). A sequence stops for a customer when they reply on WhatsApp or their lead is won or lost (each can be switched off), when someone takes them out, or when the sequence is paused. Customers are added from the sequence ("Add customer", pick a lead) or by a workflow with the new step "Add the customer to a sequence" (e.g. "a WhatsApp message with 'price' → price follow-up"); someone already in it is not added twice, and if they ask again after replying they start a fresh round. A step WhatsApp or the settings refuse (e.g. a paused template) is noted and the next steps still happen; a template value the customer does not have (no company …) skips that message instead of failing. "Who is in it" shows each customer's progress, next step and what each step did. Migration 004 moved Phase 2 sequences (calls and tasks become task steps; emails noted), paused (D32); the importer does the same. Messages say "Sequence" in the Inbox. The old "Enroll One" is replaced. 357 tests, all passing.

- **2026-10-03 — Phase 6, checkpoint A (automation engine).** Workflows now really run: "when <trigger>, only if <conditions>, then <steps>". Triggers: a new lead (by source), a WhatsApp message (with keywords), a stage change, an order stage change, a payment, and — checked every 10 minutes, once per thing — no reply for N hours, a quotation not accepted after N days, an overdue task. Conditions: source, customer tag, stage, owner, working hours. Steps: WhatsApp message (inside the 24-hour window) or approved template (variables from the customer, lead, owner …), give the lead to someone, add/remove a tag, move the stage, create a task, notify someone (the new bell in every page's top bar, live in the Inbox), wait (up to 90 days), call a webhook (public https only, signed). Every start is a run with a log of each step; Sales Automation shows the run log, stops a run, and test-runs a workflow for one lead. Runs happen once per event, retry temporary errors, stop when the workflow is paused, and cannot loop (a workflow is never re-started by its own effects; at most 4 in a row). Saving checks the people, templates (approved, every variable filled) and webhook addresses. Migration 003 moved Phase 2 workflows into the new shape, paused (D32), with notes; the importer does the same. The old "Run Now" (tasks only) is replaced by the test run. Decisions D31–D33. 349 tests, all passing.

- **2026-10-03 — Phase 5, checkpoint F (acceptance) — Phase 5 done.** One end-to-end test runs the whole quote-to-cash path through the real WhatsApp Cloud API code (Meta faked): a WhatsApp enquiry, a GST quotation made from the chat (IGST from the customer's GSTIN, discount, freight, round-off), the PDF uploaded and sent in the chat, "Quote sent, no reply", the customer opening the link (Viewed) and accepting, the order dispatched with the LR number and stock reduced, WhatsApp updates as text and as a template, payment collected and the lead won, the backup, and 404s for a teammate without the lead and for another company. The same path was run in the browser from the Inbox. 335 tests, all passing (run serially; on a busy machine the parallel run can time out, see section 10).
- **2026-10-03 — Phase 5, checkpoint E (Orders and the "Quote Sent, no reply" view).** New Orders page in the sidebar (after Quotations). "Create order" on an accepted quotation makes order SO/<year>/0001 with the same lines and totals (once; the quotation can then not be un-accepted or deleted). The order moves Received → Processing → Dispatched → Delivered → Payment Collected (any step, forwards or back, with a note) or is cancelled with a reason; dispatching asks for the transporter and LR number; a stepper and the history show every move and who made it. With "Reduce product stock when an order is dispatched" (Settings → Billing) the stock goes down once (never below zero) and comes back if the order is cancelled or moved back. "Payment Collected" wins the lead and makes the contact a customer. After a move the customer can get a WhatsApp update — a ready text (e.g. "dispatched by VRL Logistics (LR no. …)") inside the 24-hour window, otherwise an approved template with the name and order number filled in. The Inbox contact panel lists the customer's orders. Leads → "Quote sent, no reply": leads whose quotation has waited 2–14 days without a WhatsApp reply, whether it was opened, and links to the quotation and the chat. 334 tests, all passing.
- **2026-10-03 — Phase 5, checkpoint D (sending in the WhatsApp chat).** "Send on WhatsApp" on a quotation: if the customer wrote in the last 24 hours the PDF goes into their chat with a message (the online link in it, editable); otherwise an approved template is chosen — one with a document header carries the PDF, and its {{1}} {{2}} {{3}} are filled with the customer's name, the number and the total (editable, with a preview). The customer's existing chat is used, or one is opened and given to the sender; a teammate's chat, a missing mobile number, a rejected or expired quotation and missing Inbox access are refused with the reason. Only when WhatsApp accepts it does a draft become Sent and the lead Quote Sent ("sent on WhatsApp" on its timeline; a resend says "sent again"); a refusal stays visible in the chat. The Inbox shows the PDF on such template messages and opens it. The test number has a `quotation_pdf` template with a document header. 323 tests, all passing.
- **2026-10-03 — Phase 5, checkpoint C (PDF and the customer link).** "Download PDF" on every quotation: A4 with your logo, GSTIN and address, the customer and place of supply, the items with HSN/SAC, discount, taxable value and GST rate (the table header repeats on each page), the totals with CGST + SGST or IGST and the round-off, the amount in words, a GST summary by rate, bank details and a UPI QR code (a proforma invoice asks for the full amount; a quotation leaves the amount to the customer), terms, notes, a signature line, page numbers and the online link; drafts say DRAFT. Each sent quotation has a customer link (Copy customer link / Open customer view): a page that works on any phone, with "Pay with UPI" and the PDF. When the customer opens it the quotation becomes "Viewed", the editor shows how often it was opened and the lead's timeline says so. The links are signed (cannot be guessed or changed), show nothing for drafts, run no scripts and stay out of search engines. Dependencies: pdfkit; fonts: Noto Sans (OFL). Customers can only open the link once the CRM has a public https address (D18). 318 tests, all passing.
- **2026-10-03 — Phase 5, checkpoint B (Quotations page, Settings → Billing).** New Quotations page in the sidebar (after Deals): the list with search, status and type filters, and an editor for quotations, estimates and proforma invoices — started from a lead (its product and quantity become the first line), from the customer picker, or from a WhatsApp chat ("New quotation" in the contact panel). Items come from products (name, HSN/SAC, unit, price, GST rate) and can be changed; discounts in ₹ or %; the server works out every amount as you type and shows CGST + SGST or IGST, the round-off, the total in words, the place of supply and a warning when the customer's state is assumed. Drafts are saved and changed; "Mark as sent" moves the lead to Quote Sent; sent ones are revised (earlier revisions listed); accepted, rejected with a reason, undo, delete. Settings → Billing: bank details, UPI ID, standard terms, validity, round-off, number prefixes, stock option, and which GST state applies. Products have HSN/SAC and unit fields. The lead form no longer makes quotations itself (D29): "Create quotation" opens the editor. 313 tests, all passing.
- **2026-09-29 — Phase 5, checkpoint A (GST engine, billing settings, quotations API).** Decisions D27–D30 (pdfkit for the PDF, round-off to the rupee, quotes move from the lead form to the Quotations page, unknown customer state = own state with a warning). One money engine on the server: line discounts (% or flat) before GST, GST per line to the paisa, CGST + SGST (UTGST in Union Territories without a legislature) within the state, IGST across states (the customer's GSTIN first, then their state; an unknown state is assumed to be your own, with a warning), zero-rated exports/SEZ, a rate-wise summary and the round-off line. Quotations, estimates and proforma invoices are numbered per type and financial year (prefixes in the billing settings), made from a lead, a contact or a WhatsApp chat, take names, HSN codes, units, prices and rates from the products, keep copies of the customer's and your details, and can be previewed without saving. Drafts are edited in place; a sent quotation is revised (earlier versions kept); sending moves a New or Contacted lead to Quote Sent; accepted, rejected (with a reason) and, by an hourly job, expired. Billing settings API: bank, UPI ID, terms, validity, prefixes, round-off, stock option. Existing quotations get the new shape by migration 002 without any amount changing. 307 tests (one failure: the unrelated `localStor  age` typo in accounts.html).
- **2026-09-29 — Phase 4, checkpoint E (screens and acceptance) — Phase 4 done.** Settings → Lead rules (owners and admins): working hours (days, from–to, time zone, "open now"); who gets a new lead (rules tried from the top, by source, product, state and city; in turns or one person; outside working hours to a fallback person; a ready-made "everyone in turns" suggestion; reorder, pause, edit, counters); the instant WhatsApp reply (approved template, what fills each of its variables — customer's name, company, city, product, owner, your business name or fixed words — with a live preview, age limit, delay, new customers only; a suggestion when a template is approved). Leads: an Owner column, and the Notes window shows the lead's history (assigned by which rule, auto-reply sent or why not, repeat enquiries). The test lead form takes a city and state. Links to owner-only Settings tabs show an agent their profile instead of an empty panel. Acceptance: an IndiaMART lead (pulled or pushed) reaches the right salesperson's inbox with the auto-reply in about 0.1 s in tests (60 s allowed); the same in the browser. 285 tests (one failure: the unrelated `localStor  age` typo in accounts.html).
- **2026-09-29 — Phase 4, checkpoint D (assignment and auto-reply rules).** Every new enquiry — from any lead source and now also a first WhatsApp message — goes through a background job: the assignment rules give an unowned lead to someone (the first matching rule by source, product, state and city; round-robin that never gives two simultaneous leads to the same turn, or one fixed person; disabled people are skipped; with "respect working hours" leads outside the organization's hours go to a fallback person), together with the contact and any waiting WhatsApp chat, and the lead's timeline says who and why. Then the auto-reply rule for that source sends its approved WhatsApp template, filled in with the customer's name, the product, the owner or fixed text, in the lead's chat as "Auto-reply" — about a second after the enquiry with the worker running. Repeat enquiries, enquiries older than an hour (e.g. IndiaMART's first 24-hour pull), people without a mobile number, unapproved templates and marketing to opted-out people get no auto-reply, with the reason on the lead. Working hours: GET/PUT /organization/business-hours (default Mon–Sat 10:00–19:00 India time). 282 tests (one failure: the unrelated `localStor  age` typo in accounts.html).
- **2026-09-29 — Phase 4, checkpoint C (Facebook Lead Ads, Google Ads, JustDial, TradeIndia).** Facebook: connect a Page with its long-lived token and the app secret; the CRM checks the token, subscribes the Page to new leads, answers Meta's webhook handshake, accepts only signed notifications, and fetches each lead in a retried job (standard answers to the contact, custom questions into the enquiry, the form's name as the title); a refused token stops it with a clear message until a new one is pasted. Google Ads lead forms: a URL and a key to paste into Google Ads; leads without the key are refused; Google's test data shows in the log only. JustDial and TradeIndia publish no documentation: each gets an address that accepts any format (query string, form, JSON, lists) and finds the usual fields; what it cannot read stays in the log with the raw data. 272 tests (one failure: the unrelated `localStor  age` typo in accounts.html).
- **2026-09-29 — Phase 4, checkpoint B (IndiaMART).** Settings → Lead sources → Connect IndiaMART with the CRM API key: the CRM pulls every 5 minutes (never faster, even with "Pull now" or two servers), starting with the last 24 hours, with overlapping windows so nothing on a boundary is missed, at most 7 days at a time; a refused key stops the source with a clear message until a new key is pasted; IndiaMART's "wait 5 minutes" answer is waited out. The push address takes each lead the moment IndiaMART sends it; a lead that arrives by push and by pull is taken once (UNIQUE_QUERY_ID). Choose the kinds of leads (direct enquiries, buy-leads, phone calls, WhatsApp enquiries; catalogue views off by default); the kind shows in the lead's enquiry text. 264 tests (one failure: the unrelated `localStor  age` typo in accounts.html).
- **2026-09-29 — Phase 4, checkpoint A (lead intake, website forms, job queue).** Every lead source now goes through one intake: the same enquiry is taken once (the source's own id), the raw payload and the outcome are kept, contacts are matched by mobile number (else email) and blank details filled in, a repeat enquiry joins the open lead (D26), otherwise a New lead with source, product and quantity. Website enquiry forms: Settings → Lead sources gives the embed code (and a plain HTML version), options, a live preview, counters and the latest enquiries; the public endpoint works from any website, with a rate limit, a honeypot, optional allowed sites and double-submit protection. Leads shows each lead's source. Background jobs run on a small MongoDB queue (D10 revised). 256 tests (one failure: the unrelated `localStor  age` typo in accounts.html).
- **2026-09-29 — Phase 3, checkpoint E (acceptance) — Phase 3 done.** Acceptance tests: a customer writes through the real Cloud API code (Meta replaced by a fake), two agents see it live, the first reply takes the chat and the unowned customer (D25), ticks arrive out of order and end at "read", a photo is stored and only the assignee can open it, notes stay internal, a template goes out after 24 hours and a paused one is refused, forged webhooks are refused; another company sees nothing, even with ids; test numbers and the simulator are off in production. Browser run with an owner and an agent side by side against a fake Graph API. Gaps against the brief closed: the chat's contact panel shows lead stage (changeable), owner, quotations and open follow-ups (add one, mark done), and a sound plays for new messages (can be turned off). Security: every page's escapeHtml now escapes quotes (customers' names and captions reach HTML attributes); a test guards it. 240 tests (one failure: the unrelated `localStor  age` typo in accounts.html).
- **2026-09-29 — Phase 3, checkpoint D (templates, files, Customer 360 chat, click-to-chat).** Templates: sync from Meta, a "New template" form that checks Meta's rules before submitting (variables, examples, header/footer/buttons), status and rejection reason from Meta's webhook, delete; the Inbox template picker fills variables with a live preview and works any time (also to write first). Files: received photos, documents, voice notes and videos are copied into private storage straight away (checksum checked, fetched again when opened if needed); photos, video, audio and documents can be sent with a caption inside the 24-hour window within WhatsApp's limits; the Inbox shows photos, plays audio/video and downloads documents through the signed-in API. Customer 360 has a WhatsApp tab (latest messages, Open in Inbox, Message on WhatsApp) and opens any contact by link. Settings → WhatsApp makes the click-to-chat link and QR code (PNG download). Webhooks for another number on the same Meta app go to that number. New dependency `qrcode` (MIT). 215 tests (one failure: the unrelated `localStor  age` typo in accounts.html).
- **2026-09-28 — Phase 3, checkpoint C (Inbox page).** New Inbox page, right below Dashboard in the sidebar with an unread badge (also in the tab title). Chat list with Mine / Queue / All and their counts, status filter, search and "Load more". Thread with day separators, sent/delivered/read ticks, failed messages with WhatsApp's reason, quoted replies, clickable links, media/location labels, "Load earlier messages" and the 24-hour window ("Reply window: 23h left"; the composer locks when it closes). Composer: Enter sends, Shift+Enter new line, "/" opens quick replies (arrow keys + Enter), reply to a specific message. Details panel: Customer 360 link, assignee (inbox members only), Open/Pending/Closed, tags, internal notes. Quick replies manager (add, edit, delete). Live updates over Socket.IO: new chats and messages appear without reload, the token is refreshed and the page resyncs after a reconnect; optional desktop notifications. Tablet: details slide in; phone: one pane at a time. Messages now include `providerMessageId`. 204 tests (one failure: the unrelated `localStor  age` typo in accounts.html).
- **2026-09-28 — Phase 3, checkpoint B (inbox API).** Conversations with mine / unassigned / all views, search, tab counts, assign (inbox members only), status, tags, read; messages page by page. Text replies only inside the 24-hour window, saved first then sent (mock or Cloud API), failures keep WhatsApp's reason, Idempotency-Key, first reply takes the chat. Internal notes, shared quick replies. Socket.IO on the same server with token auth and per-member rooms (D24); access changes drop live connections. 201 tests.
- **2026-09-28 — Phase 3, checkpoint A (WhatsApp numbers + incoming messages).** Settings → WhatsApp connects Cloud API numbers (secrets encrypted, token shown as last 4 characters, checked with Meta, Graph API v26.0 configurable); each number has its own webhook URL and verify token. The public webhook checks `X-Hub-Signature-256` on the raw body, stores every message/status as an `InboundEvent` (retries harmless), answers 200 and then creates contact → WhatsApp lead (new numbers) → conversation → message; statuses only move forward; unprocessed items are retried. Test numbers and an inbound simulator for development. New `inbox` module. Setup guide: WHATSAPP_SETUP.md. 189 tests.
- **2026-09-28 — Phase 2, checkpoint G (final acceptance) — Phase 2 done.** Acceptance tests: an admin and an agent with "See all records" see exactly the owner's records in every module; another organization sees none, even by id (reads, notes, downloads, runs, edits, deletes). A storage test keeps `crm_*` business keys out of the pages. `GET /exports/crm` + Settings "Download CRM Data" (owners/admins) as the server backup; the browser export/import is relabelled as old browser data. The importer no longer brings back deleted products, contacts or leads. Every page opened with a full imported data set: no script errors; an admin saw the same record ids as the owner. 179 tests.
- **2026-09-28 — Phase 2, checkpoint F (Account Champions on the team API).** The Champions page shows the real team (members and pending invites) and its wizard invites teammates or changes their access through `/invites` and `/members`: View alone → viewer, Create/Edit → agent, Delete and a new "See all records" option → per-page `delete` / `view_all` grants. Invites carry name, mobile and title into the membership. The importer turns `crm_agents` into pending invites (never admins; people without an email reported; existing, disabled and removed members left alone); the import report now shows why records were skipped. 137 tests.
- **2026-09-28 — Phase 2, checkpoint E (campaigns + automation config).** Campaigns on the server (budget in paise, calendar-day dates with an end-before-start check, activity notes). Workflows (allowlisted triggers and actions) and sequences (allowlisted steps, day 0–365) as settings; `runsCount` / `enrolledCount` kept by the server. Run Now and Enroll One create their tasks on the server in one transaction with the count, accept an Idempotency-Key, refuse paused/draft automations and report the actions that are only simulated until Phase 6. The `automation` module alone no longer allows writing tasks directly. The importer moves `crm_campaigns`, `crm_workflows` and `crm_sequences`. Marketing, Sales Automation, the dashboard and reports read the server. 136 tests.
- **2026-09-24 — Phase 2, checkpoint D (documents).** Documents on the server: uploaded files go to private storage (`DOCUMENT_DIR`, never the public `/uploads`) behind `src/storage` (local disk now, a cloud driver later) and come back only through a signed-in download that is always an attachment. Size limit `DOCUMENT_MAX_MB` (default 10, was ~1.5 MB in the browser), programs and scripts refused, SHA-256 checksum, UTF-8 names, http(s) links only, replaced files removed. Agents own what they upload (D17). The importer moves `crm_documents` (base64 files into storage). Documents and Customer 360 read the server. 128 tests.
- **2026-09-24 — Phase 2, checkpoint C (tickets + notes).** Support tickets on the server with per-organization numbers from #1001 (atomic counter, never reused), a customer link (contact or typed name), category, priority, status, assignee, due date and resolved time; agents see their own tickets (D17). Notes on tickets (the reply timeline) and on contacts (Customer 360). The importer moves `crm_tickets` (old numbers kept when free), their replies and `crm_customer_notes`; re-runs no longer bring back tasks, events, tickets or notes deleted on the server, and previews count what was already imported. Support, Customer 360 and Reports read the server. 121 tests.
- **2026-09-24 — Phase 2, checkpoint B (tasks + calendar).** Tasks and calendar events on the server with assignees, related records (name kept as a snapshot), IST calendar days and wall-clock times, Done time, and "assigned to me or created by me" scope for agents. Deal follow-ups and tasks made by automation workflows are now server tasks with an `origin`, so they also show on the Tasks page. The importer moves `crm_tasks`, `crm_deal_tasks` and `crm_calendar_events`. Tasks, Calendar, Deals, Sales Automation, Dashboard, Reports and Customer 360 read the server. Invite links now use the address the CRM is open on. 112 tests.
- **2026-09-24 — Phase 2, checkpoint A (sales core).** Contacts, products, leads (one pipeline with the Deals Kanban, stage probabilities, Lost reasons, idempotent Won conversion, version checks), lead activities and server-computed quotations with financial-year numbers; agent record scope. Importer for the old browser data (preview, merge by phone/email, idempotent re-runs) and the Settings button. All sales pages and the pages that read sales data now use the server through a shared data layer in app.js; the sidebar hides modules an agent cannot open. 105 tests, including a check that each page's scripts compile together.
- **2026-09-24 — Phase 1.** Memberships (owner/admin/agent/viewer + module permissions), invites with shareable links, multi-organization switching, 15-minute access tokens with rotating httpOnly refresh cookies and reuse detection, env validation, CORS allowlist, rate limits, operator-key rejection, Joi validation, audit log, idempotency keys, counters, soft delete, tenant repository, `DATA_ENCRYPTION_KEY`, organization fields renamed by migration 001 (applied on Atlas). Frontend: token refresh across tabs, invite sign-in, company profile and team on the server (Settings → Team & Access), defects fixed (lead quotations, deal wipe, marketing script split, accounts legacy form, brand name, a pre-existing accounts.js error). 54 backend tests.
- **2026-09-24 — Phase 0.** Audit and this roadmap. Decided: D10 Agenda on MongoDB, D11 inner RealCrm repo, D12 multi-org membership, D13 one pipeline. No application code changed in Phase 0. (Earlier the same day, outside the phase plan: the backend started serving the CRM pages at `/crm/frontend`, `start-crm.vbs` / `stop-crm.vbs` launchers and the VS Code "CRM backend" task were added.)
