# BizNuma-style CRM — Master Build Prompt

> **Kaise use karein:** Claude Code me `OriginalCrm - Copy` folder kholo aur yeh likho:
> `docs/BIZNUMA_CRM_MASTER_PROMPT.md padho aur uske "PROMPT" section ko follow karo. Phase 0 se shuru karo.`
>
> Ek session me sirf ek phase karwao. Har phase ke baad khud test karo, phir agla phase bolo.
> Neeche "Agli sessions ke liye chhote prompts" section me har session ke ready-made prompts hain.

---

## PROMPT

### 1. Your role and how we work

You are a senior full-stack engineer and product architect. Your job is to turn my existing CRM ("YELLOW CRM", in this folder) into a production-grade, WhatsApp-first CRM for Indian small and medium businesses, similar to BizNuma (https://www.biznuma.com).

Working agreement:

- Talk to me in simple Hinglish. Write code, comments, commit messages and docs in English.
- Work in phases (section 7). Do exactly one phase per session unless I say otherwise.
  - Start each phase with a short plan: files to touch, new models/endpoints, risks.
  - End each phase with the report in section 10.
  - Do not start the next phase until I say "go".
- Phase 0 changes no code. It only reads the project and writes `docs/BIZNUMA_ROADMAP.md`.
- Read files before editing them. Verify every fact in section 3 against the code. If something differs, trust the code and tell me.
- Ask me only real product decisions, meaning things you cannot find in the code or docs.
  - When you ask, give your recommended option first.
  - For everything else, use the defaults in section 5 and keep going.
- Before writing integration code for an external API, check its current official docs. This covers Meta WhatsApp Cloud API, IndiaMART, JustDial, TradeIndia, Razorpay, Cashfree and Meta pricing.
  - Do not rely on memory for endpoints, versions, limits or payloads.
  - Put the doc links in our docs.
- Never print, log or commit secrets.
  - `backend/.env` exists and holds real secrets. You may read its key names, never its values.
  - Only `.env.example` gets placeholders.
- Never break what already works. That means:
  - Google login
  - organization profile and logo upload
  - Gmail connect
  - `start-crm.vbs` / `stop-crm.vbs`
  - the VS Code "CRM backend" task
  - `/api/v1/health` (the launcher checks that its JSON contains `dbState`)

### 2. What we are building (target product)

The target users are IndiaMART sellers, wholesalers, manufacturers, distributors and retailers. The BizNuma-like features:

1. **Shared WhatsApp team inbox** on the Official WhatsApp Business (Cloud) API: many agents on one number, chat assignment, internal notes, multiple numbers per company.
2. **Lead capture** from IndiaMART, JustDial, TradeIndia, Facebook Lead Ads, Google Ads lead forms, website forms and direct WhatsApp. Everything lands in one inbox with source tracking.
3. **Instant auto-reply** (under 60 seconds) to every new lead, 24/7.
4. **Auto-assignment rules:** round-robin, or by source/region/product.
5. **Lead pipeline:** New → Contacted → Quote Sent → Negotiation → Won / Lost. Plus a "quoted but silent" follow-up view.
6. **GST quotations** sent inside the WhatsApp chat: line items, CGST/SGST/IGST breakup, PDF. Also estimates and proforma invoices.
7. **Payment links** (Razorpay, Cashfree) inside the chat. Payment status syncs back to the CRM.
8. **FAQ chatbot** for price, MOQ, delivery and payment-terms questions, and product catalogue sending.
9. **Follow-up sequences** (e.g. 24h, 48h, 7 days) that stop when the customer replies.
10. **Broadcasts** with approved templates to tagged segments (region, tier A/B/C, product category). Includes delivery/read stats and opt-out.
11. **Distributor order pipeline:** Received → Processing → Dispatched → Delivered → Payment Collected.
12. **WhatsApp catalog** (Meta Commerce) sync.
13. **Reports:**
    - agent performance: first response time, response time, leads handled, deals closed
    - source-wise conversion
14. **SaaS layer:**
    - plans with limits (users, WhatsApp numbers, contacts, monthly broadcasts, quotes)
    - 30-day free trial
    - public API + webhooks, Zapier/Make
    - Meta Conversions API
    - optional AI chat assistant add-on

Reference plan limits. Keep these as config data, not hard-coded logic:

| Plan | Price/mo (+GST) | Users | WA numbers | Contacts | Broadcasts/mo | Extras |
|---|---|---|---|---|---|---|
| Starter | ₹999 | 2 | 1 | 3,000 | 10 | 50 templates, FAQ auto-reply, marketplace integrations |
| Pro | ₹2,999 | 5 | 2 | 10,000 | 100 | + payment links, Meta Conversions API |
| Growth | ₹5,999 | 10 | 2 | 40,000 | 500 | + catalog, advanced automation, API, 10,000 quotes |
| Scale | ₹9,999 | 15 | 3 | 1,00,000 | 1,000 | + 25,000 quotes |

### 3. Current codebase (verify, then build on it)

Everything is inside `OriginalCrm - Copy/`. The git root is the parent folder, and `OriginalCrm - Copy/` is still untracked there. Ask me before the first commit whether to track it.

**Backend: `backend/`**

- **Stack:** Node 24, Express 5, Mongoose 9, Joi, winston, multer, googleapis, helmet, cors, morgan. Tests use Jest + supertest. CommonJS, 2-space indent.
- **`src/app.js`:**
  - serves the frontend at `/crm/frontend` (registered before helmet on purpose)
  - serves the API at `/api/v1` and static files at `/uploads`
  - has a 404 handler and `errorHandler`
  - runs on port 3000
- **`src/routes/`:**
  - `health.js`
  - `auth.js`: `POST /auth/google` verifies the Google ID token, creates User + Organization on first login, and returns an app JWT from `utils/jwt.js`
  - `organization.js`: GET/PATCH, plus logo upload/delete to `uploads/`
  - `gmail.js`: OAuth code flow for read-only Gmail; tokens are encrypted with `utils/secretBox.js` (AES-256-GCM)
- **`src/middleware/auth.js`:** `authenticate` loads `req.user`. The tenant is `req.user.organizationId` (one organization per user).
- **`src/middleware/errorHandler.js`:** responds with `{ success:false, message, code, requestId, errors? }`. Errors are thrown as `Error` objects with `statusCode` and `code`.
- **`src/models/`:** `User`, `Organization` (`strict:false`), `GmailConnection`, `OAuthState`. No other business models exist.
- There are no controllers/services/repositories folders yet, although `docs/ARCHITECTURE.md` plans them.

**Frontend: `crm/frontend/`**

- **Pages and styling:**
  - 19 static HTML pages, vanilla JS page scripts in `js/`
  - per-module CSS, plus `css/style.css` with the design tokens: yellow brand `--brand:#ffde59`, Inter font, Font Awesome 6.5.1 from CDN, soft shadows
  - the brand name in the UI is "YELLOW CRM"
- **`js/app.js`** holds the shared helpers:
  - `crmApi(path, options)` is the only fetch wrapper. It sends the Bearer token from `localStorage.crm_session` and returns `body.data`.
  - `CRM_API_BASE` is hard-coded to `http://127.0.0.1:3000/api/v1`.
  - `injectGlobalNavItems()` is the pattern for adding a sidebar item to every page. Otherwise the sidebar HTML is copied into each page.
- **Only `login.js` and `settings.js` call the API.** All business data lives in these browser localStorage keys: `crm_company`, `crm_customers`, `crm_leads`, `crm_lead_activities`, `crm_accounts`, `crm_agents`, `crm_products`, `crm_quotations`, `crm_deals`, `crm_deal_tasks`, `crm_tasks`, `crm_calendar_events`, `crm_tickets`, `crm_ticket_seq`, `crm_campaigns`, `crm_workflows`, `crm_sequences`, `crm_documents`, `crm_customer_notes`.
- **Auth check:** each page does it inline with `if (!localStorage.getItem("crm_session"))`.
- **Current enums:**
  - lead status: `New | In Progress | Won | Lost` (`leads.html`)
  - deal stages: `Lead | Qualified | Proposal | Negotiation | Won | Lost` (`js/deals.js`)
  - ticket statuses: `Open | In Progress | Waiting on Customer | Resolved | Closed`; priorities: `Low | Medium | High | Urgent` (`js/support.js`)
  - automation actions include "Send Email (simulated)"; sequence steps: `Email | Call | Task | Wait` (`js/automation.js`)
  - marketing channels: `Email | Social | SMS | Ads | Event`, with no WhatsApp (`Marketing.html`)
  - team "Account Champions" with module permissions (`MODULES` in `js/accounts.js`)

**Specs you must follow and keep updated:**

- `BACKEND-AUDIT-SPEC.md`: canonical schemas, REST contracts, pagination, error codes, the WON-conversion algorithm, indexes, security
- `docs/ARCHITECTURE.md`
- `docs/DATABASE.md`
- `docs/API.md`
- `docs/MIGRATION.md`
- `docs/DECISIONS_REQUIRED.md`
- `docs/FRONTEND_BACKEND_GAP_ANALYSIS.md`

Where this prompt adds WhatsApp/BizNuma features, extend those docs instead of contradicting them.

**Known defects to fix in Phase 1:**

- `accounts.html` has a legacy account form that is never wired up; `accounts.js` actually manages agents.
- `Marketing.html` uses an inline script and never loads `js/marketing.js`, and their status lists differ.
- The company field names don't match. `company.html` and `routes/organization.js` use `gst/size/pincode`, while `app.js` uses `taxId/employees/zip`. Standardize on one set and migrate.
- The demo cleanup in `js/deals.js` (`crm_deals_demo_cleared`) can wipe deals.
- Lead WON conversion runs on edits, so an ordinary edit can create a quotation. Quotation totals and numbers are computed in the browser and trusted.
- `middleware/requestId.js` requires `uuid` but never uses it. `uuid` is not a declared dependency and only resolves through `gaxios`. Remove the import.
- `config/env.js` hard-codes a Google client ID fallback, and nothing validates env vars at startup.
- The app JWT has no refresh or revocation, `cors()` accepts every origin, and there is no rate limiting.

### 4. Target architecture

Keep the stack: Express + MongoDB/Mongoose + vanilla HTML/CSS/JS. Don't migrate to React or TypeScript unless I ask. Reuse the existing design tokens and UI patterns (cards, tables, modals, kanban, toasts) so new pages look native.

- **Layers:**
  - routes → validators (Joi) → controllers → services → repositories → models, as in `docs/ARCHITECTURE.md`
  - every repository query is scoped by `organizationId` from the authenticated context
  - never accept `organizationId`, owner, role, totals, counters or probabilities from the client
- **Tenancy and roles:**
  - add `OrganizationMember`: roles `owner | admin | agent | viewer`, plus module permissions matching `MODULES`
  - add invites and a `requirePermission(module, action)` middleware
  - agents see only the records and conversations assigned to them, unless an admin grants "view all"
- **Common building blocks:**
  - pagination, a soft-delete plugin, audit log, idempotency records
  - atomic counters for ticket, quotation and order numbers
  - consistent error codes
  - rate limiting (`express-rate-limit`) and NoSQL-operator sanitization
  - env validation at boot
- **Real-time:** Socket.IO, authenticated with the app JWT, with rooms per organization and per conversation.
- **Background jobs:**
  - BullMQ + Redis (recommended), or Agenda on MongoDB if I don't want Redis; ask me in Phase 0
  - all sends, polls, sequences, broadcasts and heavy webhook work go through jobs, with retries and idempotency
- **Transactions:** MongoDB transactions need a replica set. Document how to run a single-node replica set locally, and use Atlas in production.
- **Integrations:** each one lives under `src/integrations/<name>/` behind an interface.
  - `whatsapp`: Meta Cloud API, plus a `MockProvider` for dev and tests
  - `leadSources`: IndiaMART, JustDial, TradeIndia, Facebook Lead Ads, Google Ads, website form
  - `payments`: Razorpay, then Cashfree
  - `storage`: local `uploads/` now, S3/R2-compatible later
  - `ai`: optional
  - The app must run fully without real credentials, using the mock providers.
- **Webhooks:**
  - Keep the raw body for signature checks: Meta `X-Hub-Signature-256` with the app secret, and the Razorpay signature.
  - Reply 200 fast and queue the real work.
  - Process idempotently by the provider's event/message ID.
  - Meta needs a public HTTPS URL. Explain to me how to use a tunnel (cloudflared or ngrok) locally.
- **Secrets per organization** (WhatsApp tokens, IndiaMART keys, Razorpay keys):
  - encrypt them with `secretBox` under a general `DATA_ENCRYPTION_KEY`
  - existing Gmail data must stay readable
  - never return these secrets to the browser
- **Frontend API:**
  - derive the API base from `window.location.origin` when the backend serves the page (keep the localhost fallback)
  - add a shared auth guard and a 401 → logout handler in `app.js`
  - add loading, empty and error states everywhere
- **Security:**
  - everything that comes from WhatsApp, lead sources or customers is untrusted
  - render it with `escapeHtml`/`textContent`, never raw `innerHTML`
  - validate uploads by content, the way `utils/logoFile.js` does

### 5. Default product decisions (propose these in Phase 0; I can override)

- **Currency and money:** INR only. Store amounts as integer paise and round each line to 2 decimals.
- **GST:**
  - product prices are tax-exclusive
  - place of supply is the customer's state (from the GSTIN state code if present, otherwise the address)
  - same state as the organization → CGST + SGST (half each); different state → IGST
  - products get `hsnSac`, `unit`, `moq` and images
- **Contact model:**
  - one `Contact` per E.164 phone number (default +91), unique per organization
  - fields: optional email, company, GSTIN, state, city, tags, source, owner, lifecycle `lead | customer`
  - leads, deals, conversations, quotations, orders and tickets reference `contactId`
  - migrate the existing customers and leads into this model
  - merge legacy Accounts into `Contact.company`; "Account Champions" stays the team page
- **Lead stages:** `New → Contacted → Quote Sent → Negotiation → Won / Lost`. Lost needs a reason.
  - map old values: In Progress → Contacted, Qualified/Proposal → Quote Sent
  - make the stage list configurable per organization later
- **Lead sources:** `WhatsApp | IndiaMART | JustDial | TradeIndia | Facebook | Google Ads | Website | Manual | Import`.
- **Quotations:**
  - types: Quotation / Estimate / Proforma Invoice
  - status: `Draft → Sent → Viewed → Accepted | Rejected | Expired`
  - numbers per financial year (April–March), e.g. `QT/2026-27/0001`, from an atomic counter
  - revisions are kept
- **Orders:** `Received → Processing → Dispatched → Delivered → Payment Collected`, plus Cancelled. Stock is informational by default, with an optional setting to reduce stock on Dispatched.
- **Inbox:** conversation status `Open | Pending | Closed`. The server enforces the 24-hour customer-service window: outside it, only approved templates can be sent.
- **Opt-in/opt-out:** store consent per contact. A STOP or UNSUBSCRIBE reply automatically opts the contact out of marketing broadcasts.

### 6. Things I must set up myself (guide me step by step when a phase needs them)

- **Meta:** a Developer app, a WhatsApp Business Account, business verification, a phone number, a permanent System User token, the app secret and a webhook verify token.
- **Lead sources:** an IndiaMART CRM API key (needs a paid seller account). For JustDial and TradeIndia, research what they actually offer and tell me honestly what is possible.
- **Payments:** Razorpay/Cashfree API keys and a webhook secret.
- **Hosting:** a public HTTPS domain/server, a MongoDB replica set (Atlas), and Redis if we choose BullMQ.

### 7. Phased roadmap

Each phase lists its deliverables and acceptance checks. Keep the checklist in `docs/BIZNUMA_ROADMAP.md` updated.

**Phase 0: Audit and plan (no code changes)**

- Read every file in `backend/src`, every page and script in `crm/frontend`, and all the docs listed in section 3.
- Write `docs/BIZNUMA_ROADMAP.md` containing:
  - a gap table: BizNuma feature → current state → what to build
  - the data model: collections, key fields, indexes, relationships
  - the new API endpoints, socket events and job queues
  - the decisions from section 5 plus any others you found, each with a recommendation
  - risks, and the effort for each phase
- Ask me the open decisions, then stop.

**Phase 1: Foundation and hardening**

- Fix every defect listed in section 3.
- Add OrganizationMember, invites, roles/permissions and the tenant middleware.
- Add access + refresh tokens with rotation and revocation, as in `BACKEND-AUDIT-SPEC.md` §10.
- Add a CORS allowlist, rate limits, env validation and the common building blocks from section 4.
- Update the frontend `app.js`: shared auth guard, 401 handling, API base.
- Tests: tenant isolation, RBAC, token refresh, and that the health response still contains `dbState`.

**Phase 2: Core CRM moves to the server**

- Build models and APIs for:
  - Contacts
  - Leads, with activities and an idempotent convert
  - Products
  - Deals, with the pipeline and stage changes guarded by a version check
  - Tasks and Events
  - Tickets, with notes and atomic numbers
  - Documents, behind the storage abstraction
  - Campaign/Workflow/Sequence config
- Rewrite each page's JS to use `crmApi` instead of localStorage. The UI must look the same.
- Build `POST /imports/localstorage` with a preview and a report, plus a Settings button "Move my browser data to server".
- Accept only when:
  - two members of one organization see the same data, and another organization sees none of it
  - `grep` finds no `crm_*` business keys left in the frontend (only the session/user keys)

**Phase 3: WhatsApp Cloud API and shared team inbox**

- **Models:**
  - `WhatsAppAccount`: WABA id, phone number id, display number, encrypted token, status, quality rating
  - `Conversation`: contact, number, assignee, status, `lastInboundAt` (for the 24h window), unread count, tags
  - `Message`:
    - direction
    - type: text, image, document, audio, video, location, template or interactive
    - a unique provider message id
    - status (sent/delivered/read/failed) with timestamps and error
  - `InternalNote`, `QuickReply`, `MessageTemplate`
- **Settings → WhatsApp:** connect a number (manual IDs + token first, Embedded Signup later). Webhook at `GET/POST /api/v1/webhooks/whatsapp`.
- **Inbound message flow:** upsert the contact by phone → conversation → message → socket event.
  - if the contact is new, auto-create a lead with source WhatsApp
  - download incoming media to storage
- **Outbound:**
  - text and media inside the 24h window
  - templates with variables outside it
  - status webhooks update the ticks
- **Templates:** sync from Meta, create and submit for approval, show their status.
- **New page `Inbox.html` + `js/inbox.js` + `css/inbox.css`.** Add it to the sidebar right after Dashboard, using `injectGlobalNavItems`.
  - **Conversation list:** filters Mine / Unassigned / All / Open / Closed, plus search.
  - **Chat thread:**
    - message ticks and media
    - template picker
    - `/` quick replies
    - a notes toggle
  - **Contact panel:** stage, tags, owner, assign, quotes, orders, tasks.
  - **Notifications:** unread badge, sound, browser notifications.
  - **Responsive:** works down to phone width.
- **Also in this phase:**
  - Customer 360 shows the chat timeline.
  - Settings gets a click-to-chat link + QR generator.
  - A dev-only inbound simulator endpoint, disabled in production.

**Phase 4: Lead sources, auto-reply, auto-assign**

- **IndiaMART:**
  - use the CRM pull API as a scheduled job per organization
  - respect their rate limits and dedupe by their unique query id
  - also use push/webhook if it exists
- **Other sources:**
  - Facebook Lead Ads (leadgen webhook)
  - Google Ads lead form webhook
  - website form endpoint + embeddable JS snippet, with a per-organization public key, rate limit and honeypot
  - JustDial/TradeIndia through whatever official method exists
- **Normalizing:** turn everything into Contact + Lead with `source`, `sourceRef` and the raw payload. Dedupe by phone.
- **Auto-reply rules:** per source, send template X within 60 seconds.
- **Assignment rules:**
  - round-robin among active agents
  - or by source/product/state/city
  - respect working hours, with a fallback owner
  - keep the assignment history
- **Accept when** a simulated IndiaMART lead appears in the inbox, gets the auto-reply and is assigned correctly, all within 60 seconds.

**Phase 5: Pipeline, GST quotations, orders**

- **Pipeline:** the new lead stages with a data migration, a lead Kanban, and a smart view "Quote Sent, no reply for N days".
- **Organization settings:** GSTIN, state code, bank details, UPI ID, default terms, number prefixes.
- **`Quotations.html`:**
  - create a quote from a lead, contact or chat, with items picked from products
  - line discounts (% or flat) and the GST breakup from section 5
  - validity, terms and revisions
  - a PDF with logo, GSTIN, bank details and UPI QR
  - send the PDF into the WhatsApp chat: as a document message inside the 24h window, or as a template with a document header outside it
  - "Viewed" tracking via a signed link
- **`Orders.html`:**
  - create an order from an accepted quote, then move it through the stage pipeline
  - dispatch details: transporter, LR number
  - optionally send the customer a WhatsApp template update on each stage change
- **Tests:** unit tests for the money math: intra- vs inter-state, rounding, discounts, zero-rated items.

**Phase 6: Automation engine, FAQ bot, follow-ups**

- Replace every simulated automation with real, job-backed execution.
- **Triggers:**
  - lead created (by source)
  - message received (keyword)
  - stage changed
  - no reply for X hours
  - quote not accepted in X days
  - order stage changed
  - payment received
  - task overdue
- **Conditions:** source, tag, stage, owner, business hours.
- **Actions:**
  - send a WhatsApp text/template
  - assign, tag, change stage
  - create a task, notify an agent
  - wait
  - call a webhook
- **Sequences:** e.g. 24h/48h/7d. They stop automatically when the contact replies.
- **FAQ bot:**
  - keyword rules plus interactive buttons/lists for price, MOQ, delivery and payment terms
  - hand-off to a human
  - greeting message, and an away message outside business hours
- **Run logs:** one log per execution, visible in the UI.

**Phase 7: Broadcasts and segmentation**

- **Contacts:**
  - tags and saved segments
  - CSV/Excel import with column mapping, phone normalization and dedupe
  - consent and opt-out handling
- **Broadcast:**
  - template + per-contact variables + segment
  - scheduling and throttled sending
  - per-recipient status and stats: sent/delivered/read/replied/failed
  - the plan's monthly quota
  - an estimated Meta cost by template category (verify current Meta pricing)
- **Marketing page:** add the WhatsApp channel, and fix the `Marketing.html` inline-script split.

**Phase 8: Payments and catalog**

- **Payment links:**
  - Razorpay Payment Links first, then Cashfree, with per-organization keys
  - create a link from a quote, order or chat
  - webhook with signature check → mark paid → send a receipt message
- **Dues:** an outstanding-dues list and a reminder automation.
- **Catalog:**
  - sync products to a Meta Commerce catalog
  - send product and product-list messages
  - orders placed from the catalog create Orders

**Phase 9: Reports and dashboard**

- **Agent performance:** first response time, average response time, conversations handled, leads by stage, deals won and their value.
- **Funnels:** source funnel and conversion, quotation win rate, broadcast performance, payment collection.
- **Consistency:** date ranges apply to every chart (fix the all-time charts noted in the audit). Add CSV export and update the dashboard KPIs.
- **AI Insights:** base the page on real server data.

**Phase 10: SaaS layer and extras**

- **Plans and billing:**
  - the plans/limits from section 2, with usage meters and friendly upgrade prompts
  - a 30-day trial
  - subscription billing (Razorpay Subscriptions) with a GST invoice
- **API and integrations:**
  - a public REST API with hashed per-organization API keys and scopes
  - signed outbound webhooks
  - Zapier/Make docs
  - Meta Conversions API for lead events
- **AI assistant (opt-in add-on):**
  - reply suggestions and auto-answers grounded in the organization's products and FAQ, using the Anthropic Claude API
  - check the current model list in the official docs: a Haiku-class model for cheap auto-replies, a Sonnet-class model for suggestions
  - human hand-off and usage logging
- **Mobile and login:**
  - a PWA (manifest, service worker, web push) for agents on mobile
  - phone OTP login (via a WhatsApp authentication template) alongside Google
- **Admin and ops:**
  - an audit-log viewer, full data export, organization deletion
  - a production deployment guide: HTTPS domain, Atlas replica set, Redis, PM2 or a hosting platform, backups, log rotation

### 8. Engineering rules for every phase

- Match the existing code style:
  - CommonJS and 2-space indent
  - the `error.statusCode` / `error.code` pattern
  - the `{ success, data, pagination?, message? }` response shape
- Validate every request with Joi, tenant-scope every query, and paginate every list (max 100).
- **Tests:**
  - use Jest + supertest with `mongodb-memory-server`, in replica set mode for transactions
  - mock every external provider; tests never call the real network
  - run the full test suite before saying a phase is done, and paste the result
- **Docs:** keep `.env.example`, `docs/API.md`, `docs/DATABASE.md`, `docs/ARCHITECTURE.md` and `docs/BIZNUMA_ROADMAP.md` current. Add a short dated changelog entry per phase.
- **Git:**
  - one branch per phase: `feature/phase-N-<name>`
  - small, focused commits
  - never commit `.env`, `uploads/`, `node_modules/` or logs
- Don't add a library when a few lines of code will do, and don't create files that aren't needed.
- If a phase is too big for one session, stop at a clean, working, tested checkpoint and tell me exactly where to resume.

### 9. Definition of done (whole project)

Everything below must work for multiple users with full tenant isolation, both with the mock providers and with real credentials:

1. An admin signs up, fills in the company details (GSTIN, bank, UPI), invites 2 agents and connects a WhatsApp number.
2. An IndiaMART lead arrives. Within 60 seconds it gets the auto-reply and is assigned round-robin, and the agent sees it live in the shared inbox.
3. The agent chats, sends a GST quotation PDF in the chat, then sends a payment link. The payment marks the order paid and moves the lead to Won.
4. The admin broadcasts a template to the "Tier A – Rajasthan" segment and sees the delivery/read stats.
5. The admin opens the agent performance report.

### 10. End-of-phase report format (in Hinglish)

1. What was built (short bullets)
2. How I can test it myself, step by step (URLs, buttons, sample data, simulator command)
3. Test results (the command, plus a pass/fail summary)
4. What is left, known issues and risks
5. Any decision you need from me, with your recommendation
6. The updated roadmap checklist

---

## Agli sessions ke liye chhote prompts

- **Phase 0:** `docs/BIZNUMA_CRM_MASTER_PROMPT.md ka PROMPT section follow karo. Phase 0 karo: sirf padhna aur plan banana, koi code change nahi.`
- **Phase N:** `docs/BIZNUMA_CRM_MASTER_PROMPT.md aur docs/BIZNUMA_ROADMAP.md padho. Phase N shuru karo. Pehle plan dikhao, phir kaam karo.`
- **Kaam beech me ruk gaya ho:** `docs/BIZNUMA_ROADMAP.md me last checkpoint dekho aur wahi se Phase N continue karo.`
