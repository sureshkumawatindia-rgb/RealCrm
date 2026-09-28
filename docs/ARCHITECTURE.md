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
- Webhooks: `/api/v1/webhooks/*` gets a raw body (`express.raw`, before the JSON parser) so signatures are checked on the exact bytes, is mounted before the API rate limit with its own limit, and its keys are masked in the request log. Items are stored as `InboundEvent`s first, answered 200, then processed (`whatsappInboundService.processLater`, retried by `startRetryLoop`). `realtime/bus.js` carries `message:new` / `message:status` for the realtime layer.
- Realtime: `server.js` creates one HTTP server for Express and Socket.IO (`realtime/socket.js`). Sockets authenticate with the access token and join `member:<id>`, `org:<id>:inbox-all` (sees every chat) or `org:<id>:inbox` (the queue); services emit on `realtime/bus.js` and `socket.js` forwards to exactly those rooms. `member:access-changed` (member updated or removed) drops that member's sockets.
- Inbox page: `Inbox.html` + `js/inbox.js` (one IIFE, no globals) + `css/inbox.css`. It loads the Socket.IO browser client from the server, keeps its own list in sync from `conversation:updated` / `message:new` / `message:status` / `note:new`, refreshes the access token when the socket says `UNAUTHORIZED`, and reloads the list and the open chat after a reconnect. `app.js` adds the sidebar item with the unread badge (`setInboxNavBadge`) on every page.
- Integrations: `integrations/whatsapp` (`metaCloud` = Graph API client with timeouts, `mock` for development; `providerFor(account)`).
- Frontend guards: `frontendScripts.test.js` (page scripts compile together) and `frontendStorage.test.js` (no `crm_*` business keys; only app.js, login.js and the Settings migration screen write localStorage).
- Migrations: `src/migrations`, each idempotent, recorded in `migrations`.

## 7. Transactions

MongoDB transactions need a replica set. Atlas is one; local development can run a single-node replica set (see [BIZNUMA_ROADMAP.md](BIZNUMA_ROADMAP.md) section 11); tests use `MongoMemoryReplSet`.
