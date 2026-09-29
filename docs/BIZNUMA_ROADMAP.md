# BizNuma-style CRM Roadmap

Turning YELLOW CRM into a WhatsApp-first CRM for Indian SMBs (IndiaMART sellers, wholesalers, manufacturers, distributors, retailers).

- Brief: [BIZNUMA_CRM_MASTER_PROMPT.md](BIZNUMA_CRM_MASTER_PROMPT.md)
- Canonical backend spec: [../BACKEND-AUDIT-SPEC.md](../BACKEND-AUDIT-SPEC.md) (this roadmap extends it; where they differ, the decision log in section 9 wins and the spec gets updated in the phase that implements it)
- Status: **Phase 4 in progress** on branch `feature/phase-4-lead-sources` (built on the Phase 3 branch; nothing merged to main or pushed yet). Checkpoint 4A (lead intake, website forms, job queue) done on 2026-09-29; resume at 4B (IndiaMART). Phase 3 done on 2026-09-29 except one check with a real Meta account (the code path is tested against a fake Graph API). Phase 2 done on 2026-09-28. Phase 1 still waits for one check with a real Google account.

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
Checkpoints: **4A lead intake + website forms + job queue (done)** → 4B IndiaMART (pull + push) → 4C Facebook Lead Ads, Google Ads, JustDial/TradeIndia → 4D auto-reply + assignment rules → 4E Settings screens + acceptance.
- [x] (4A) Background jobs on MongoDB (D10 revised: own small queue instead of Agenda)
- [ ] IndiaMART pull job (5-minute rule, dedupe by UNIQUE_QUERY_ID) + push endpoint
- [ ] Facebook Lead Ads, Google Ads lead form, website form + embed snippet, JustDial/TradeIndia (whatever is officially possible, section 8) — (4A) website form + embed snippet (per-form public key, rate limit, honeypot, optional allowed sites, plain HTML fallback)
- [x] (4A) Normalize to Contact + Lead with source, sourceRef, raw payload; dedupe by phone (and by the source's own id); D26 for repeat enquiries
- [ ] Auto-reply rules (template within 60 s), assignment rules (round-robin / by source, product, state, city; working hours; fallback; history)
- [ ] Accept: simulated IndiaMART lead → inbox + auto-reply + correct assignment, all within 60 s

### Phase 5 — Pipeline, GST quotations, orders
- [ ] "Quote Sent, no reply for N days" view (the new stages and the lead Kanban arrived in Phase 2 with D13)
- [ ] Organization settings: GSTIN, state code, bank, UPI ID, terms, number prefixes
- [ ] Quotations.html: items, discounts, GST breakup, validity, terms, revisions, PDF, send in chat, "Viewed" tracking
- [ ] Orders.html: from accepted quote, stage pipeline, dispatch details, optional WhatsApp updates
- [ ] Money-math unit tests (intra/inter-state, rounding, discounts, zero-rated)

### Phase 6 — Automation engine, FAQ bot, follow-ups
- [ ] Real job-backed triggers, conditions, actions; sequences that stop on reply
- [ ] FAQ bot (keywords + buttons/lists, hand-off, greeting, away message)
- [ ] Run logs visible in the UI

### Phase 7 — Broadcasts and segmentation
- [ ] Tags, saved segments, CSV/Excel import with mapping + phone normalization + dedupe, consent/opt-out
- [ ] Broadcast: template + variables + segment, scheduling, throttling, per-recipient stats, plan quota, cost estimate
- [ ] Marketing page: WhatsApp channel (the inline-script split was fixed in Phase 1)

### Phase 8 — Payments and catalog
- [ ] Razorpay Payment Links, then Cashfree; per-org keys; from quote/order/chat; signed webhooks → paid → receipt
- [ ] Outstanding dues + reminder automation
- [ ] Meta Commerce catalog sync, product / product-list messages, catalog orders → Orders

### Phase 9 — Reports and dashboard
- [ ] Agent performance, funnels, quotation win rate, broadcast performance, payment collection
- [ ] Date ranges apply to every chart; CSV export; dashboard KPIs; AI Insights on server data

### Phase 10 — SaaS layer and extras
- [ ] Plans + limits (config), usage meters, 30-day trial, Razorpay Subscriptions with GST invoice
- [ ] Public API (hashed keys, scopes), signed outbound webhooks, Zapier/Make docs, Meta Conversions API
- [ ] Optional AI assistant (Claude API), PWA + web push, phone OTP login, audit-log viewer, data export, org deletion, production deployment guide

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

**Phase 8**: `GET/PUT /payment-connections/:provider`, `POST /payment-links`, `GET /payment-links`, `POST /webhooks/payments/razorpay`, `POST /webhooks/payments/cashfree`, `GET /dues`, `POST /catalog/sync`

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
| `payment.webhook.process` | payment webhook stored | mark paid, receipt, move lead to Won |
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
| D18 | Production hosting | Decide before Phase 3 goes live: a small VPS with PM2 + Nginx + Let's Encrypt, or a platform like Render/Railway. Local development uses a tunnel (section 11). | Before Phase 3 |
| D22 | WhatsApp webhook URL | One callback URL per connected number (`/api/v1/webhooks/whatsapp/<random key>`) with its own verify token and app secret, instead of one shared URL: each company can use its own Meta app, and the signature is checked before the payload is read. | Decided in Phase 3A (engineering) |
| D23 | Background jobs in Phase 3 | Webhook items are stored first and processed in-process with a retry loop; Agenda (D10) is added when polling and broadcasts need scheduled jobs (Phase 4). | Decided in Phase 3A (engineering) |
| D24 | Which chats an agent sees | Chats assigned to them **and** chats nobody has taken yet (a shared queue); `inbox:view_all` sees all. The first reply assigns an unassigned chat to the sender. | Decided 2026-09-28 (recommended option a) |
| D25 | Who owns a WhatsApp customer | Whoever the chat is assigned to (by hand, by the first reply, or by starting the chat from a contact) becomes the owner of its contact and open leads **if nobody owns them yet**; a teammate's records are never taken. Phase 4 assignment rules will set the owner first. | Decided 2026-09-29 (recommended option) |
| D26 | A repeat enquiry from someone with an open lead | Added to that open lead (an "Enquiry" activity; its follow-up moves to now) instead of a second lead; the same source enquiry is never taken twice; once the lead is Won or Lost the next enquiry is a new lead. | Decided 2026-09-29 (recommended option) |
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
| India's DPDP Act 2023 and its rules (consent, access, deletion) | Compliance exposure for a SaaS | Consent per contact, data export and org deletion (Phase 10); verify current obligations before launch |
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
| Before launch | Domain + HTTPS hosting (D18), paid Atlas tier (D19), backups |

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
