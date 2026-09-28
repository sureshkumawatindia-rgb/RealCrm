# API

All routes are under `/api/v1`. The backend also serves the CRM pages at `/crm/frontend/`.

- Authenticated requests send `Authorization: Bearer <access token>` (the app's own JWT, 15 minutes by default).
- The refresh token is an httpOnly cookie `crm_refresh` (path `/api/v1/auth`, SameSite=Strict). Browsers on another allowed origin must call the auth endpoints with `credentials: "include"`.
- Every request is scoped to the organization in the access token. Nothing in a request body can change the organization, owner, role, totals or counters.

## Response shape

```json
{ "success": true, "data": {}, "message": "optional" }
{ "success": true, "data": [], "pagination": { "page": 1, "limit": 20, "total": 45, "totalPages": 3, "hasNextPage": true, "hasPreviousPage": false } }
{ "success": false, "message": "Validation failed", "code": "VALIDATION_ERROR", "errors": [{ "field": "gstin", "code": "STRING_PATTERN_BASE", "message": "GSTIN must be 15 characters, for example 08ABCDE1234F1Z5" }], "requestId": "..." }
```

Lists take `page` (default 1) and `limit` (default 20, max 100).

Status codes: 400 validation / invalid JSON / invalid id, 401 not signed in or token expired, 403 not allowed, 404 not found (also for records of another organization), 409 conflict, 413 body too large, 422 idempotency key reused with another body, 429 rate limited, 500 generic error (details only in the server log).

Common error codes are listed in `backend/src/constants/errorCodes.js`.

## Health

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | `{ status, dbState, timestamp }`. 200 when MongoDB is connected, 503 otherwise. `start-crm.vbs` looks for `"dbState"`. Not rate limited. |

## Auth

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/auth/google` | none | Body `{ credential, inviteToken? }`. Verifies the Google ID token, creates the user on first sign-in, accepts pending invites for the verified email, creates an organization only if the user belongs to none. Returns `{ token, user, organizationId, member, memberships, inviteError? }` and sets the refresh cookie. |
| `POST` | `/auth/refresh` | refresh cookie | Rotates the refresh token and returns `{ token, organizationId }`. A token that was already rotated revokes its whole family (`REFRESH_TOKEN_REUSED`). |
| `POST` | `/auth/logout` | refresh cookie | Revokes the session family and clears the cookie. |
| `GET` | `/auth/me` | bearer | `{ user, organization, member, memberships }`. |
| `POST` | `/auth/switch-organization` | bearer | Body `{ organizationId }`. Returns a new access token for another organization the user belongs to. |

Rate limit for `/auth/google`, `/auth/refresh`, `/auth/logout` and `/invites/lookup`: `RATE_LIMIT_AUTH_PER_MINUTE` (default 20) per IP. Everything else: `RATE_LIMIT_API_PER_MINUTE` (default 300).

## Organization

| Method | Route | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/organization` | any member | Company profile: `name, industry, size, foundedYear, website, email, phone, gstin, stateCode, address, city, state, country, postalCode, description, logoUrl`. |
| `PATCH` | `/organization` | owner, admin | Any of the fields above except `stateCode` and `logoUrl`. `gstin` must be a valid 15-character GSTIN or empty; `stateCode` is derived from it. |
| `POST` | `/organization/logo` | owner, admin | Multipart field `logo`: PNG, JPG, SVG or WebP up to 2 MB, content checked against the extension. |
| `DELETE` | `/organization/logo` | owner, admin | Removes the logo. |

Uploaded files are served from `/uploads/` with `Content-Security-Policy: sandbox`.

## Team

Roles: `owner`, `admin`, `agent`, `viewer`. Agents and viewers only see the modules in `modules` (keys in `backend/src/constants/permissions.js`); extra grants are `<module>:delete` and `<module>:view_all`.

| Method | Route | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/members` | any member | Team list (paginated). |
| `PATCH` | `/members/:id` | owner, admin | `{ role?, modules?, permissions?, status?, displayName?, mobile?, assignable? }`. Nobody changes their own role/status; only owners change owners and admins; the last active owner is protected. |
| `DELETE` | `/members/:id` | owner, admin | Removes the member (soft delete) and ends their sessions in this organization. |
| `GET` | `/invites?status=pending\|accepted\|revoked\|all` | owner, admin | Invites (default pending; `status: "expired"` in the response when past `expiresAt`). |
| `POST` | `/invites` | owner, admin | `{ email, role: admin\|agent\|viewer, modules?, permissions? }`. Returns `{ invite, link }`; the link (valid 7 days) is only shown here. Only owners invite admins. Accepts `Idempotency-Key`. |
| `POST` | `/invites/:id/resend` | owner, admin | New link; the old one stops working. |
| `DELETE` | `/invites/:id` | owner, admin | Cancels the invite. |
| `POST` | `/invites/lookup` | none | `{ token }` → `{ organizationName, email, role, expiresAt }` for the login page. POST keeps the token out of URL logs. |

## Gmail OAuth

The browser never receives or stores Gmail access or refresh tokens; they are encrypted at rest.

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/gmail/connect` | bearer | Body `{ returnUrl }`. Creates a user-bound OAuth state and returns the Google authorization URL. |
| `GET` | `/gmail/oauth/callback` | Google redirect | Exchanges the code, stores the encrypted connection, redirects to Settings. |
| `GET` | `/gmail/connection` | bearer | Connected status and Gmail address. |
| `GET` | `/gmail/profile` | bearer | Profile from Gmail. |
| `GET` | `/gmail/messages?limit=&q=` | bearer | Recent message metadata. |

In Google Cloud Console, enable the Gmail API and add the exact `GOOGLE_REDIRECT_URI` (default `PUBLIC_URL/api/v1/gmail/oauth/callback`) to the OAuth client's authorized redirect URIs. Sign-in from a page address also needs that origin (for example `http://127.0.0.1:3000`) under "Authorized JavaScript origins". Scope: `https://www.googleapis.com/auth/gmail.readonly`.

## Sales core (Phase 2)

Module permissions: contacts need `customers`; leads and quotations need `leads` or `deals`; products are readable by every member and writable with `products`. Agents and viewers only see records they own unless they have `<module>:view_all`. Only owners/admins can set `ownerId`; everyone else owns what they create. Money is integer paise.

### Contacts

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/contacts?q=&lifecycle=lead\|customer&status=&ownerId=&tag=&sort=&page=&limit=` | Search name/email/phone/company/city. |
| `POST` | `/contacts` | `{ name, email?, phone?, company?, gstin?, state?, city?, address?, tags?, source?, lifecycle?, status?, productIds?, notes?, ownerId? }`. The phone is stored as entered and as E.164 (`+91` added to 10-digit numbers); an invalid phone is 400 `INVALID_PHONE`, a number that another contact has is 409 `DUPLICATE_CONTACT`. |
| `GET/PATCH/DELETE` | `/contacts/:id` | Delete is a soft delete and frees the phone number. |

### Products

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/products?q=&category=&active=&sort=` | Catalog (any member). |
| `POST` | `/products` | `{ name, sku?, category?, description?, unit?, hsnSac?, pricePaise?, gstRatePct?, moq?, stockQty?, images?, active? }` — tax-exclusive price in paise. |
| `GET/PATCH/DELETE` | `/products/:id` | |

### Leads (the single pipeline; the Deals page is its Kanban)

Stages: `New → Contacted → Quote Sent → Negotiation → Won / Lost`. The server sets `probability` from the stage (10/25/50/75/100/0) and never accepts it from the browser.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/leads?q=&stage=&ownerId=&productId=&contactId=&followUpFrom=&followUpTo=&sort=` | Each lead includes a `contact` summary. `q` also searches the contact's name, email, phone and company. |
| `POST` | `/leads` | `{ contactId }` or `{ contact: { name, email?, phone?, company? } }` (reuses the contact with the same phone, else the same email) plus `title?, stage?, lostReason?, source?, productId?, quantity?, expectedValuePaise?, expectedCloseDate?, followUpAt?, ownerId?, notes?, noteEntries? }`. Accepts `Idempotency-Key`. A lead created as Won converts. |
| `GET/PATCH/DELETE` | `/leads/:id` | PATCH may include `contact: {...}` (updates the linked contact), `stage`, and `version` (409 `VERSION_CONFLICT` if someone else changed the lead). |
| `POST` | `/leads/:id/stage` | `{ stage, lostReason?, version? }`. Lost without a reason is 422 `LOST_REASON_REQUIRED`. Won makes the contact a customer. |
| `POST` | `/leads/:id/convert` | Idempotent: moves to Won and marks the contact as customer once. |
| `GET/POST` | `/leads/:id/activities` | Timeline (created, stage changes, notes, quotations); POST `{ text, type? }` adds a note. |
| `POST` | `/leads/:id/quotations` | `{ items: [{ productId?, name?, quantity, unitPricePaise, discountPaise?, taxRatePct? }], validUntil? }` — creates the lead's draft quotation (201) or updates it (200). Totals are computed on the server. |

### Quotations

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/quotations?leadId=&contactId=&status=` | Numbers per financial year: `QT/2026-27/0001`. |
| `GET` | `/quotations/:id` | |
| `PATCH` | `/quotations/:id` | `{ status }` (Draft, Sent, Viewed, Accepted, Rejected, Expired). |
| `DELETE` | `/quotations/:id` | Soft delete. |

## Tasks and calendar (Phase 2)

Calendar days are `YYYY-MM-DD` strings and times are `HH:MM` wall-clock times in `Asia/Kolkata`, so a date never shifts with the browser's timezone. Agents and viewers see tasks and events assigned to them or created by them; `<module>:view_all` on any module that reads them shows all. Any member may assign work to an active teammate (400 `INVALID_ASSIGNEE` otherwise).

`relatedType` is `Customer`, `Contact`, `Lead`, `Deal` or `Account`. With a `relatedId` (a contact for Customer/Contact, a lead for Lead/Deal) the server checks it exists in the organization (400 `INVALID_RELATED`) and stores the current name as `relatedName`. Accounts have no id yet, so only `relatedName` is kept.

### Tasks

Read: `tasks`, `calendar`, `deals`, `dashboard`, `customers` or `reports`. Create/edit: `tasks`, `deals` (follow-ups) or `automation` (workflow runs). Delete: `tasks` or `deals`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/tasks?q=&status=&priority=&origin=&assigneeId=&relatedType=&relatedId=&dueFrom=&dueTo=&sort=&page=&limit=` | `q` searches title and description. |
| `POST` | `/tasks` | `{ title, description?, dueDate?, priority? (Low/Medium/High), status? (To Do/In Progress/Done), origin? (manual/deal_followup/automation), assigneeId?, relatedType?, relatedId?, relatedName? }`. |
| `GET/PATCH/DELETE` | `/tasks/:id` | PATCH cannot change `origin`. Setting `status: Done` records `completedAt`; any other status clears it. `dueDate: ""` removes the due date. Delete is a soft delete. |

### Calendar events

Read: `calendar`, `dashboard`, `customers` or `reports`. Create/edit/delete: `calendar`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/events?q=&from=&to=&type=&assigneeId=&relatedType=&relatedId=&sort=&page=&limit=` | `from`/`to` filter on `date` (inclusive). |
| `POST` | `/events` | `{ title, date, type? (Meeting/Call/Follow-up/Demo/Deadline/Reminder), startTime?, endTime?, description?, assigneeId?, relatedType?, relatedId?, relatedName? }`. An end time needs a start time (otherwise it is dropped); an end at or before the start is 400 `END_BEFORE_START`. |
| `GET/PATCH/DELETE` | `/events/:id` | Delete is a soft delete. |

## Support tickets and notes (Phase 2)

Read: `support`, `customers` or `reports`. Create/edit: `support`. Delete: `support` (agents need `support:delete`). Agents and viewers see tickets assigned to them or created by them unless they have `<module>:view_all` (D17).

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/tickets?q=&status=&priority=&category=&assigneeId=&contactId=&sort=&page=&limit=` | `q` searches subject, description, customer name and imported assignee names. |
| `POST` | `/tickets` | `{ subject, description?, contactId?, customerName?, category? (Technical/Billing/General/Feature Request/Bug Report), priority? (Low/Medium/High/Urgent), status? (Open/In Progress/Waiting on Customer/Resolved/Closed), dueDate?, assigneeId? }`. The server gives the number (per organization, from 1001, never reused). A `contactId` links the customer and sets `customerName` to the contact's name (400 `INVALID_CONTACT` if unknown); without one, the typed `customerName` is kept. |
| `GET/PATCH/DELETE` | `/tickets/:id` | Moving to Resolved or Closed records `resolvedAt`; reopening clears it. `dueDate: ""` removes the due date. Delete is a soft delete. |
| `GET` | `/tickets/:id/notes` | The ticket's replies, newest first (up to 200). |
| `POST` | `/tickets/:id/notes` | `{ text }` (needs `support`). The author is the signed-in member. |
| `GET` | `/contacts/:id/notes` | Customer 360 notes, newest first (`customers` view, and the contact must be visible to the member). |
| `POST` | `/contacts/:id/notes` | `{ text }` (`customers` edit). |

A note is `{ id, parentType (ticket/contact), parentId, text, authorName, authorMemberId, createdAt }`.

## Documents (Phase 2)

Read: `documents` or `customers` (Customer 360). Create/edit: `documents`. Delete: `documents` (agents need `documents:delete`). Agents and viewers see the documents they own unless they have `<module>:view_all` (D17); only owners/admins can set `ownerId`, everyone else owns what they upload.

A document is either an uploaded file or a web link. Files are kept in private storage (`DOCUMENT_DIR`, default `backend/storage/documents`), never under the public `/uploads`, and are only given out through the signed-in download below.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/documents?q=&category=&relatedType=&relatedId=&ownerId=&sort=&page=&limit=` | `q` searches name, description, file name, related name and tags. |
| `POST` | `/documents` | `multipart/form-data` with an optional `file` field plus `name, category? (Contract/Invoice/Proposal/Report/Template/Other), description?, tags? ("a, b" or a list), ownerId?, relatedType?, relatedId?, relatedName?, linkUrl?`; or JSON for a link. Exactly one of `file` or `linkUrl` (400 `FILE_OR_LINK_REQUIRED`). Files up to `DOCUMENT_MAX_MB` (default 10; 413 `FILE_TOO_LARGE`); programs and scripts (.exe, .bat, .js, ...) are refused (400 `FILE_TYPE_NOT_ALLOWED`); empty files are refused (400 `EMPTY_FILE`). Links must be `http(s)`. The server keeps the file name (UTF-8), type, size and SHA-256 `checksum`. |
| `GET` | `/documents/:id` | `{ ..., hasFile, fileName, mimeType, sizeBytes, checksum, linkUrl }` (the storage key is never sent). |
| `PATCH` | `/documents/:id` | Same fields, all optional. A new `file` replaces the old file (and any link); a `linkUrl` replaces the file. The replaced file is removed from storage. |
| `DELETE` | `/documents/:id` | Soft delete; the file stays in storage. |
| `GET` | `/documents/:id/download` | The file, always as `application/octet-stream` with `Content-Disposition: attachment` and a `sandbox` CSP, so an uploaded HTML/SVG file can't run in the CRM. 404 `NO_FILE` for a link document, 404 `FILE_MISSING` if the file is gone from storage. |

## Campaigns and automation settings (Phase 2)

Agents and viewers see the campaigns, workflows and sequences they own unless they have `<module>:view_all` (D17); only owners/admins can set `ownerId`. Money is paise.

### Campaigns

Read: `marketing`, `dashboard` or `reports`. Create/edit: `marketing`. Delete: `marketing` (agents need `marketing:delete`).

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/campaigns?q=&type=&status=&ownerId=&startFrom=&startTo=&sort=&page=&limit=` | `q` searches name, audience and description; `startFrom`/`startTo` filter the start day. |
| `POST` | `/campaigns` | `{ name, type? (Email/Social/SMS/Ads/Event), status? (Draft/Scheduled/Active/Paused/Completed), startDate?, endDate?, budgetPaise?, leadsGenerated?, audience?, description?, ownerId? }`. Days are `YYYY-MM-DD`; an end before the start is 400 `END_BEFORE_START`. |
| `GET/PATCH/DELETE` | `/campaigns/:id` | `""` clears a date. Delete is a soft delete. |
| `GET/POST` | `/campaigns/:id/notes` | The campaign's activity notes, newest first; POST `{ text }` needs `marketing`. |

### Workflows and sequences

Module: `automation` (read, create, edit; delete needs `automation:delete` for agents). These are settings only: the automation engine (real triggers, emails, notifications) arrives in Phase 6. `runsCount` and `enrolledCount` are kept by the server and never accepted from the browser.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/workflows?q=&status=&ownerId=` and `/sequences?q=&status=&ownerId=` | |
| `POST` | `/workflows` | `{ name, trigger (Lead Created/Lead Status Changed to Won/Deal Created/Deal Stage Changed to Won/Deal Stage Changed to Lost/Task Overdue/Customer Added), status? (Active/Paused/Draft), actions?: [{ type (Create Task/Send Email (simulated)/Notify Agent/Update Status/Add to Sequence), detail? }] (up to 20), ownerId? }` |
| `POST` | `/sequences` | `{ name, targetType? (Leads/Deals/Customers), status?, steps?: [{ day (0–365), type (Email/Call/Task/Wait), note? }] (up to 30), ownerId? }` |
| `GET/PATCH/DELETE` | `/workflows/:id`, `/sequences/:id` | Soft delete. |
| `POST` | `/workflows/:id/run` | Run Now. Creates one task per "Create Task" action (title = the action's detail, due in 2 days IST, assigned to the workflow's owner while they are an active member, `origin: automation`) and adds 1 to `runsCount`, in one transaction. Answers `{ workflow, tasks, simulated }`; `simulated` lists the configured actions that were not carried out. 409 `NOT_ACTIVE` unless the workflow is Active. Send an `Idempotency-Key` so a retried click runs once. |
| `POST` | `/sequences/:id/enroll` | Enroll One. Creates a task for the earliest Call/Task step (due in that many days) and adds 1 to `enrolledCount`. Answers `{ sequence, task, firstTaskDay, simulated }`. Same `NOT_ACTIVE` and `Idempotency-Key` rules. |

Since checkpoint E the `automation` module alone no longer allows `POST /tasks`; automation tasks are created by the two endpoints above.

### Moving browser data to the server

| Method | Route | Role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/imports/localstorage` | owner, admin | `{ data: { crm_products: "<json>", ... }, dryRun }` (up to 25 MB). Imports products, customers, accounts, leads, deals (as leads), lead activities, quotations, tasks, deal follow-ups (as tasks with origin `deal_followup`), calendar events, support tickets (old numbers kept when free, otherwise renumbered with `legacyNumber`), ticket replies, customer notes and documents (browser files go to private storage; links get `https://` when it was missing; bad links and programs are reported), campaigns (budget → paise, notes → campaign notes), workflows and sequences (unknown triggers, actions and steps reported; old run/enroll counts kept); contacts are matched by phone, then email (deals: name + company). Task and event assignees are matched to team members by name, else the name is kept; related records are matched by name among imported and existing ones. Old ids are kept, so running it again creates nothing new (and tasks, events, tickets, notes, documents, campaigns, workflows and sequences deleted on the server are not brought back). Returns a report per section (`found, created, alreadyImported, merged, rejected`), `unresolved` notes and `later` (keys that move in a later update). `dryRun: true` writes nothing. |
| `GET` | `/imports/:id` | owner, admin | A previous run and its report. |

## Idempotency

`POST` endpoints that accept `Idempotency-Key` (8–128 characters) return the stored response for a repeated key with the same body (header `Idempotent-Replayed: true`), `422 IDEMPOTENCY_KEY_REUSED` for a different body, and `409 IDEMPOTENCY_IN_PROGRESS` while the first request is still running. Records expire after 24 hours.

## Planned

The rest of Phase 2 moves Account Champions to the team API; then WhatsApp, lead sources, GST quotations, orders, broadcasts and payments. See [BIZNUMA_ROADMAP.md](BIZNUMA_ROADMAP.md) section 6 for the full endpoint plan.
