# Backend Architecture

## 1. Overview

A modular monolith: Node.js 24, Express 5, MongoDB with Mongoose 9. One server (port 3000) serves both the API (`/api/v1`) and the static CRM pages (`/crm/frontend/`). The target feature set and phase plan are in [BIZNUMA_ROADMAP.md](BIZNUMA_ROADMAP.md).

## 2. Directory Structure

```text
backend/
├── jest.config.js           # in-memory MongoDB replica set per test run
├── src/
│   ├── app.js               # middleware order, static pages, /api/v1, errors
│   ├── server.js            # env warnings → MongoDB → migrations → listen
│   ├── config/              # env (validated at boot), database, logger
│   ├── constants/           # roles, modules, permissions, error codes
│   ├── routes/              # URL → middleware → controller
│   ├── validators/          # Joi schemas (body, query, params)
│   ├── controllers/         # HTTP in/out only
│   ├── services/            # business rules (auth, members, CRM records, import); access.js = record scope (D17)
│   ├── repositories/        # tenantRepository: every query scoped to one organization
│   ├── models/              # Mongoose schemas + plugins/softDelete
│   ├── middleware/          # auth, permissions, validate, sanitize, rateLimit, idempotency, errors
│   ├── storage/             # private file storage for documents (local disk; S3/R2 driver later)
│   ├── integrations/        # google/idToken today; whatsapp, leadSources, payments later
│   ├── migrations/          # data migrations run once at startup
│   ├── utils/               # tokens, cookies, secretBox, audit, counter, pagination, gstin
│   └── tests/               # Jest + supertest suites, helpers, setup
├── .env.example
└── package.json
```

## 3. Request flow

`app.js` order: request id → static CRM pages (before helmet, so its CSP does not block the pages' inline scripts and Google Sign-In) → helmet → CORS allowlist → JSON body (5 MB) → reject `$`/prototype keys → `/uploads` (sandbox CSP) → request log (paths only, no query strings) → rate limit → `/api/v1` routes → 404 → error handler.

Inside a route: `authenticate` → `requireRole` / `requirePermission` → `validate` (Joi) → controller → service → repository/model.

- **Controllers** translate HTTP to service calls.
- **Services** hold the rules (who may change which member, last-owner protection, invite acceptance, session rotation).
- **Repositories**: `tenantRepository(Model, organizationId)` applies the organization last, so client input can never override it.

## 4. Authentication and tenancy

- **Sign-in**: Google ID token → `POST /auth/google` → user + memberships. Pending invites for the verified email are accepted; a new organization is created only for a user with no memberships. Users from before memberships existed get an owner membership for their old organization.
- **Access token**: HS256 JWT, 15 minutes, claims `sub` (user id), `org` (active organization), `sid` (session), issuer `yellow-crm`, audience `yellow-crm-api`.
- **Refresh token**: 32 random bytes in an httpOnly, SameSite=Strict cookie limited to `/api/v1/auth`; only its SHA-256 is stored (`sessions`). Each refresh rotates it inside the same family; presenting a rotated token revokes the family. Logout and member removal revoke sessions.
- **Tenant context**: `authenticate` loads the user and the active membership and sets `req.tenant = { organizationId, memberId, userId, role }`. A removed or disabled member gets 401 `MEMBERSHIP_REVOKED` immediately.
- **Roles**: owner and admin can do everything (only owners manage owners/admins); agents work in their assigned modules (delete and view-all are extra grants); viewers only read. `can(member, module, action)` in `constants/permissions.js` is the single rule.
- **Frontend**: `crmApi` sends the access token; on 401 it refreshes once (tabs coordinate with the Web Locks API) and otherwise returns to the login page.

## 5. Security

Helmet on the API, CORS allowlist (`CORS_ORIGINS` plus the public URL and local dev ports), rate limits per IP, Joi validation with unknown fields dropped, rejection of MongoDB operator keys, generic 500 messages, request ids, redacted audit logs, secrets encrypted with AES-256-GCM (`DATA_ENCRYPTION_KEY`, older Gmail values still readable), logo uploads checked by content and served sandboxed, documents kept in private storage and only downloaded by signed-in members as attachments (size limit, programs refused), env validated at boot with no hard-coded fallbacks.

## 6. Building blocks

- Pagination: `page`/`limit` (max 100) and the `pagination` response object.
- Soft delete plugin: `deletedAt`, hidden from queries unless the filter mentions `deletedAt`.
- Audit log: `audit(req, { action, entityType, entityId, changes })`, never throws.
- Idempotency: `Idempotency-Key` middleware stores responses for 24 hours.
- Counters: `nextSequence(organizationId, name, { start })`, atomic per organization (quotation numbers per financial year, ticket numbers).
- Record scope: `visibilityFilter` (owner: contacts, leads, documents, campaigns, workflows, sequences) and `assignedOrCreatedFilter` (tasks, events, tickets) in `services/access.js`; `<module>:view_all` lifts it.
- Service factories: `createWorkItemService` (tasks, events, tickets) and `createOwnedRecordService` (campaigns, workflows, sequences) give list/get/create/update/remove with scope, audit and soft delete; `routes/workItems.js` `resourceRouter` gives the matching routes.
- Dates: calendar days are `YYYY-MM-DD` strings; `utils/dates.indiaDate(n)` is today in IST plus n days.
- Storage: `documentStorage.put / open / remove` with server-made keys `<organization id>/<random>`.
- Export: `exportService.streamExport` writes `GET /exports/crm` section by section from cursors, waiting for the connection when its buffer is full.
- Background jobs: `src/jobs/queue.js` (D10) keeps jobs in MongoDB; each server process claims due jobs with an atomic update (lock with a timeout, so a dead worker's job is taken over), retries failures with a growing pause, and repeats recurring jobs. `src/jobs/index.js` registers the handlers; `server.js` starts the worker.
- Lead intake: `leadIntakeService.intake` is the one way an enquiry becomes a contact and lead (dedupe by source id and phone, D26 for repeat enquiries, raw payload in `leadintakes`), then emits `lead:intake` on the bus for assignment and auto-reply rules. Website forms (`routes/public.js`, mounted before the API rate limit with its own) accept posts from any site and serve `embed.js`.
- Lead routing: `leadRoutingService` listens for `lead:intake` (lead sources and first WhatsApp messages) and enqueues `lead.route`: `assignmentService.pickOwner` / `assignLead` (rules, atomic round-robin, working hours from `utils/businessHours`), then `autoReplyService.schedule` → `lead.autoreply`, which sends through `conversationService.sendTemplateAutomatically` (`deliver()` with the system as sender: no member, never takes the chat).
- Lead rules screens: `Settings.html` → Lead rules, `js/settings-routing.js` (one IIFE, owners/admins; loads when the tab opens). Rules are tried in the order shown; moving one renumbers priorities 10, 20, 30…. `js/leads.js` shows the owner and the lead history (`GET /leads/:id/activities`). Owner-only Settings scripts call `leaveManagerTab(panel)` so a direct link does not show others an empty panel. `leadAcceptance.test.js` is the Phase 4 end-to-end check (real worker, sockets, fake IndiaMART and Meta).
- GST quotations (Phase 5): `utils/gst.js` is the only place with money maths (`supplyFor` decides CGST+SGST/UTGST vs IGST from the organization's and customer's states, `priceLine`/`priceDocument` in integer paise with BigInt half-up rounding, rate summary, round-off); `constants/gst.js` has the GST state codes. `quotationService` builds documents from it (product defaults, customer and seller copies, numbering per type and financial year, revisions, status rules, lead → Quote Sent) and registers the hourly `quotations.expire` job. Billing settings live on the organization (`organizationService.billingOf`).
- Quotations page (Phase 5): `Quotations.html` + `js/quotations.js` (one IIFE) + `css/quotations.css`: the list and the editor in one page, addressed by `?id=` or `?new=1&leadId=|contactId=|conversationId=` (history push/pop, a warning before leaving unsaved changes). The editor never adds money up itself: every change calls `POST /pricing/preview` (debounced, stale answers ignored) and shows the server's line amounts, tax split, round-off and warnings. `app.js` adds "Quotations" after Deals on every page and `PAGE_MODULES` allows several modules per page (leads or deals). Settings → Billing is `js/settings-billing.js`. The lead form no longer edits quotations (D29); leads, the Inbox contact panel and the chat open the editor.
- Quotation PDF and link (Phase 5, D27): `services/quotationPdf.js` draws the A4 PDF with pdfkit (the items table is drawn by hand so its header repeats on each page; buffered pages get the footer, page numbers and the draft watermark; ligatures off so copied text stays right) using Noto Sans from `backend/assets/fonts` (OFL, it has ₹). The UPI QR follows NPCI's `upi://pay?pa=&pn=&am=&cu=INR&tn=` link. `utils/signedLink.js` signs public ids; `routes/quotationLinks.js` (mounted at `/q` before the API) serves `views/quotationPage.js` (server-rendered HTML, everything escaped, logo and QR as data: URLs) and counts views through `quotationService.openShared`.
- Sending a quotation (Phase 5D): `quotationService.sendOptions` / `sendOnWhatsApp` pick the customer's latest chat (or open one with `conversationService.start`), render the PDF and call `conversationService.sendGeneratedDocument`, which goes through the same `deliver()` as every send: the PDF is stored first (the chat keeps a copy), uploaded to WhatsApp, sent as a document (window open) or as a template whose DOCUMENT header gets `{ type: "document", document: { id, filename } }` (`templateService.buildSend(…, { document })`; `shapeOf(…, { withDocument })` keeps such templates out of the inbox picker). Only after WhatsApp accepted it does the quotation become Sent.
- Orders (Phase 5E): `orderService` (create from an accepted quotation in a transaction that also links the quotation; stage moves with history, dispatch details, stock taken once and returned exactly via `stockMoves`, "Payment Collected" → `leadService.convert`; WhatsApp updates through `conversationService.sendText` / `sendTemplate` on the customer's latest chat). `Orders.html` + `js/orders.js` (list with stage tabs, detail with a stepper, stage and update dialogs; shares `css/quotations.css`). `quotationService.awaitingReply` drives the Leads page's "Quote sent, no reply" panel (latest sent quotation per lead vs. the chat's `lastInboundAt`).
- Webhooks: `/api/v1/webhooks/*` gets a raw body (`express.raw`, before the JSON parser) so signatures are checked on the exact bytes, is mounted before the API rate limit with its own limit, and its keys are masked in the request log. Items are stored as `InboundEvent`s first, answered 200, then processed (`whatsappInboundService.processLater`, retried by `startRetryLoop`). `realtime/bus.js` carries `message:new` / `message:status` for the realtime layer.
- Realtime: `server.js` creates one HTTP server for Express and Socket.IO (`realtime/socket.js`). Sockets authenticate with the access token and join `member:<id>`, `org:<id>:inbox-all` (sees every chat) or `org:<id>:inbox` (the queue); services emit on `realtime/bus.js` and `socket.js` forwards to exactly those rooms. `member:access-changed` (member updated or removed) drops that member's sockets.
- Inbox page: `Inbox.html` + `js/inbox.js` (one IIFE, no globals) + `css/inbox.css`. It loads the Socket.IO browser client from the server, keeps its own list in sync from `conversation:updated` / `message:new` / `message:status` / `note:new`, refreshes the access token when the socket says `UNAUTHORIZED`, and reloads the list and the open chat after a reconnect. `app.js` adds the sidebar item with the unread badge (`setInboxNavBadge`) on every page.
- Integrations: `integrations/whatsapp` (`metaCloud` = Graph API client with timeouts: messages, templates, media upload/lookup/download; `mock` for development with sample templates and sample files; `providerFor(account)`).
- WhatsApp files: `whatsappMediaService` copies received files into the document storage right after the message is stored (checksum checked; a failure is retried when someone opens the file), classifies files to send by extension against Meta's types and limits, and streams files back only through the signed-in API. Sending (`conversationService.deliver`) always saves the message first, then uploads/sends, then records sent or failed.
- Templates: `templateService` turns Meta's components into variables for the picker, checks new templates against Meta's layout rules before submitting, and builds the send payload (positional or named parameters); the template status webhook updates status and reason.
- Frontend guards: `frontendScripts.test.js` (page scripts compile together; every `escapeHtml` also escapes quotes, because escaped text is used inside attributes) and `frontendStorage.test.js` (no `crm_*` business keys; only app.js, login.js and the Settings migration screen write localStorage; `crm_prefs` holds page preferences such as the inbox sound, via `getPreference` / `setPreference`).
- Customer ownership from chats (D25): `conversationService.claimCustomer` gives an unowned contact and its open leads to whoever the chat is assigned to; it never overwrites an owner.
- Migrations: `src/migrations`, each idempotent, recorded in `migrations`.

## 7. Transactions

MongoDB transactions need a replica set. Atlas is one; local development can run a single-node replica set (see [BIZNUMA_ROADMAP.md](BIZNUMA_ROADMAP.md) section 11); tests use `MongoMemoryReplSet`.
