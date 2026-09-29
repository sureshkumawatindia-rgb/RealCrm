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

Roles: `owner`, `admin`, `agent`, `viewer`. Agents and viewers only see the modules in `modules` (keys in `backend/src/constants/permissions.js`); extra grants are `<module>:delete` and `<module>:view_all`. The Account Champions page (and Settings → Team & Access) use these endpoints; there is no separate agents API.

| Method | Route | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/members` | any member | Team list (paginated). |
| `PATCH` | `/members/:id` | owner, admin | `{ role?, modules?, permissions?, status?, displayName?, mobile?, title?, assignable? }` (`title` = what they do, e.g. Sales, up to 60 characters). Nobody changes their own role/status; only owners change owners and admins; the last active owner is protected. |
| `DELETE` | `/members/:id` | owner, admin | Removes the member (soft delete) and ends their sessions in this organization. |
| `GET` | `/invites?status=pending\|accepted\|revoked\|all` | owner, admin | Invites (default pending; `status: "expired"` in the response when past `expiresAt`). |
| `POST` | `/invites` | owner, admin | `{ email, role: admin\|agent\|viewer, modules?, permissions?, displayName?, mobile?, title? }` (name, mobile and title are copied to the membership when it is accepted). Inviting a pending email again replaces its access and link. Returns `{ invite, link }`; the link (valid 7 days) is only shown here. Only owners invite admins. Accepts `Idempotency-Key`. |
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
| `POST` | `/imports/localstorage` | owner, admin | `{ data: { crm_products: "<json>", ... }, dryRun }` (up to 25 MB). Imports products, customers, accounts, leads, deals (as leads), lead activities, quotations, tasks, deal follow-ups (as tasks with origin `deal_followup`), calendar events, support tickets (old numbers kept when free, otherwise renumbered with `legacyNumber`), ticket replies, customer notes and documents (browser files go to private storage; links get `https://` when it was missing; bad links and programs are reported), campaigns (budget → paise, notes → campaign notes), workflows and sequences (unknown triggers, actions and steps reported; old run/enroll counts kept) and Account Champions (`crm_agents`, as pending invites; see MIGRATION.md); contacts are matched by phone, then email (deals: name + company). Task and event assignees are matched to team members by name, else the name is kept; related records are matched by name among imported and existing ones. Old ids are kept, so running it again creates nothing new (and records deleted on the server are not brought back). Returns a report per section (`found, created, alreadyImported, merged, rejected`, and `rejectedRows` with the reasons), `unresolved` notes and `later` (keys that move in a later update). `dryRun: true` writes nothing. |
| `GET` | `/imports/:id` | owner, admin | A previous run and its report. |
| `GET` | `/exports/crm` | owner, admin | "Download CRM Data": one JSON file (`crm-export-YYYY-MM-DD.json`, streamed) with `organization`, `team` (name, email, role, title, access; no tokens) and every record of `contacts, products, leads, leadActivities, quotations, tasks, events, tickets, notes, documents, campaigns, workflows, sequences`. Deleted records, secrets and internal fields (`organizationId`, `storageKey`, `deletedAt`) are left out; uploaded files are not included. |

## WhatsApp (Phase 3)

Setup steps for Meta: [WHATSAPP_SETUP.md](WHATSAPP_SETUP.md). Module for the inbox pages: `inbox`.

### Numbers (Settings → WhatsApp, owners and admins)

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/whatsapp/accounts` | Connected numbers: `{ id, name, provider (meta/mock), phoneNumberId, wabaId, displayPhone, verifiedName, qualityRating, status (pending/connected/error), statusMessage, isDefault, lastWebhookAt, webhookPath, webhookUrl, verifyToken, accessToken: { configured, last4 }, appSecretConfigured }`. The access token and app secret are never returned. |
| `POST` | `/whatsapp/accounts` | `{ name?, provider?, phoneNumberId, wabaId?, accessToken, appSecret }` (Meta) or `{ provider: "mock", name? }` (development only). The CRM asks Meta about the number (`GET /<version>/<phoneNumberId>`) and saves the result as `status`. A number connected anywhere else is 409 `NUMBER_IN_USE`. |
| `PATCH` | `/whatsapp/accounts/:id` | `{ name?, wabaId?, accessToken?, appSecret?, isDefault: true? }`; a new token is checked again. |
| `POST` | `/whatsapp/accounts/:id/test` | Asks Meta again and updates `status`. |
| `DELETE` | `/whatsapp/accounts/:id` | Soft delete; chats stay, the number can be connected again. |
| `GET` | `/whatsapp/click-to-chat?accountId=&text=` | `{ accountId, phone, link, qrDataUrl }`: the `https://wa.me/<number>?text=<pre-filled message>` link of a number (default number if none given) and its QR code as an SVG data URL. 400 `NO_DISPLAY_PHONE` until the number was checked with Meta. |
| `GET` | `/whatsapp/click-to-chat/qr.png?accountId=&text=` | The same QR code as an 800 px PNG download (`whatsapp-qr.png`). |

### Webhook (public, called by Meta)

Each number has its own URL `/api/v1/webhooks/whatsapp/<webhookKey>` (not rate limited with the API; own limit `RATE_LIMIT_WEBHOOK_PER_MINUTE`).

| Method | Purpose |
| --- | --- |
| `GET` | Handshake: `?hub.mode=subscribe&hub.verify_token=<verify token>&hub.challenge=<n>` → 200 with the challenge, else 403. |
| `POST` | Messages, statuses and template status changes (fields `messages` and `message_template_status_update`). `X-Hub-Signature-256` must be `sha256=` + HMAC-SHA256 of the raw body with the app secret (else 401). Items for another connected number of the same organization (one Meta app, one callback URL) go to that number; unknown numbers are skipped. Each message and status is stored as an `InboundEvent` (Meta's retries are ignored), the answer is 200, then: the contact is found by phone or created (source WhatsApp; a new number also gets a WhatsApp lead), the conversation is opened, the message stored, the 24-hour window moved; statuses move sent → delivered → read (never back; failed keeps Meta's error); photos, documents, audio and video are copied into private storage (see "Files in chats"); a template status change updates the template (reason kept). Events that could not be processed are retried at start-up and every 5 minutes. |

### Inbox (module `inbox`)

Who sees which chat (D24): owners, admins and members with `inbox:view_all` see every chat; other inbox members see chats assigned to them and chats nobody has taken yet. Chats outside that are 404.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/conversations` | `{ contactId, accountId? }`: opens the chat with a contact the member can see (201, assigned to them; the window is closed until the customer writes, so the first message is a template), or returns the existing one (200). 409 `CHAT_ASSIGNED` if a teammate has it; 400 `NO_PHONE` without a mobile number. |
| `GET` | `/conversations?view=mine\|unassigned\|all&status=open\|pending\|closed\|any&accountId=&contactId=&q=&page=&limit=` | Newest first. `contactId` lists one customer's chats (Customer 360). Default status: open and pending. `q` searches the contact's name, company and number. Each item: `{ id, contact { id, name, phone, company }, account { id, name, displayPhone, verifiedName }, assigneeId, status, unreadCount, lastMessageAt, lastMessagePreview, lastMessageDirection, lastInboundAt, window { open, expiresAt }, tags }`. |
| `GET` | `/conversations/summary` | `{ mine, unassigned, all, unread }` for the inbox tabs (open and pending chats). |
| `GET` | `/conversations/:id` | One chat. |
| `PATCH` | `/conversations/:id` | `{ status?, assigneeId? (null = back to the queue), tags? }`. The assignee must be an active member who can open the inbox (400 `ASSIGNEE_NO_INBOX`); they become the owner of the contact and its open leads if nobody owns them yet (D25). |
| `POST` | `/conversations/:id/read` | Sets `unreadCount` to 0. |
| `GET` | `/conversations/:id/messages?limit=&before=<message id>` | The newest page (default 50, max 100), oldest → newest inside the page; `hasMore` and `nextBefore` for older ones. Each message has `providerMessageId` (WhatsApp's id) and `replyToProviderMessageId`, so a reply can show the message it quotes. |
| `POST` | `/conversations/:id/messages` | A text `{ text, replyToMessageId? }`, or a template `{ type: "template", templateId, variables: { header: { "1": "…" }, body: { "1": "…" \| "customer_name": "…" }, buttons: { "<button index>": "<end of the link>" } } }` (`Idempotency-Key` recommended). Texts only within 24 hours of the customer's last message (else 422 `WINDOW_CLOSED`); an approved template of the chat's number can be sent any time (422 `TEMPLATE_NOT_SENDABLE` otherwise; every variable must be filled, without line breaks or tabs). The chat shows the template with its values filled in. The message is saved, then sent through the Cloud API: returns 201 with `status: "sent"`, or `status: "failed"` and WhatsApp's `error`. The first reply assigns an unassigned chat to the sender (and, per D25, makes them the owner of the unowned contact and its open leads); a reply reopens a closed chat. |
| `POST` | `/conversations/:id/messages/media` | Multipart: `file` + optional `caption` (not for audio) and `replyToMessageId`; inside the 24-hour window. WhatsApp's types and limits: photos JPG/PNG 5 MB, video MP4/3GP 16 MB, audio MP3/OGG/AAC/AMR/M4A 16 MB, documents PDF/Word/Excel/PowerPoint/TXT 100 MB (else 400 `UNSUPPORTED_FILE` / 413 `FILE_TOO_LARGE`). The file is kept in private storage, uploaded to WhatsApp, then sent. `Idempotency-Key` covers the file too. |
| `GET` | `/conversations/:id/messages/:messageId/media` | The message's file, always as a download (`application/octet-stream`, `Content-Security-Policy: sandbox`). A received file not stored yet is fetched from WhatsApp first (404 `MEDIA_UNAVAILABLE` after WhatsApp's 7 days). |
| `GET/POST` | `/conversations/:id/notes` | Internal notes `{ text }` (never sent to the customer). |
| `GET` | `/quick-replies` | Saved answers of the organization. |
| `POST` | `/quick-replies` | `{ shortcut (a-z, 0-9, - or _, up to 30), title?, body }`; a shortcut in use is 409 `DUPLICATE_SHORTCUT`. |
| `PATCH/DELETE` | `/quick-replies/:id` | Deleting needs `inbox:delete` for agents. |

### Message templates

Templates belong to a number's WhatsApp Business Account: a Meta number needs its `wabaId` (400 `WABA_ID_MISSING`). Inbox members read them; owners and admins change them.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/templates?accountId=&status=APPROVED` | `{ id, accountId, name, language, category, status, parameterFormat (POSITIONAL/NAMED), rejectedReason, qualityScore, header { format, text, variables }, body { text, variables }, footer, buttons [{ index, type, text, url, phoneNumber, variables }], sendable, notSendableReason }`. Not sendable: not approved, authentication templates, photo/video/document headers, button types the CRM cannot fill. |
| `POST` | `/templates/sync` | `{ accountId? }`: reads all of the number's templates from Meta (every page) and removes the ones Meta no longer has. |
| `POST` | `/templates` | `{ accountId?, name (a-z, 0-9, _), language (en, en_US, hi …), category (UTILITY/MARKETING), headerText?, headerExample?, bodyText, bodyExamples? { "1": "…" }, footerText?, buttons? [{ type: QUICK_REPLY \| URL (url) \| PHONE_NUMBER (phoneNumber), text }] (up to 3) }` → submitted to Meta for review (status usually PENDING; test numbers approve at once). Checked first: variables all numbers {{1}}, {{2}} … without gaps or all names, an example for each, the message may not start or end with a variable, one header variable at most, none in the footer or links. 409 `TEMPLATE_EXISTS`. |
| `DELETE` | `/templates/:id` | Deletes this language of the template at Meta (`hsm_id`) and here. |

### Live updates (Socket.IO)

Same address as the API (path `/socket.io`; the browser client is served at `/socket.io/socket.io.min.js`). Connect with `auth: { token: <access token> }`; members without the inbox get `FORBIDDEN`, bad tokens `UNAUTHORIZED`. Events (server → browser), only for chats the member may see: `conversation:updated` (a conversation), `message:new` (`{ conversation, message }`), `message:status` (a message; also sent when a received file has been stored), `note:new` (`{ conversationId, note }`). When a member's role, pages or status change (or they are removed) their connections are dropped; the browser reconnects with its current token and gets the new access.

### Development only (404 when `NODE_ENV=production`)

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/dev/simulate/lead` | Owners/admins. `{ source? (default IndiaMART), sourceRef?, name, phone, email?, company?, city?, state?, product?, quantity?, message? }` → the same intake as a real lead; returns `{ outcome, leadId, contactId, contactCreated }` (400 `LEAD_REJECTED` without a valid mobile number or email). |
| `POST` | `/dev/simulate/whatsapp-inbound` | Owners/admins. `{ from, name?, type? (text/image/document/audio), text, accountId? }` → processes a made-up incoming message exactly like a webhook (photos, documents and voice notes only on test numbers, with a sample file; `text` is then the caption); returns `{ conversationId, messageId, contactId }`. |

## Lead sources (Phase 4)

### Connections (Settings → Lead sources, owners and admins)

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/lead-sources` | `{ id, type (website; more in 4B/4C), source, name, status (active/paused/error), statusMessage, settings, stats { received, created, attached, duplicate, rejected }, lastLeadAt, lastError, credentials { configured, hint }, form? { publicKey, submitUrl, embedUrl } }` |
| `POST` | `/lead-sources` | `{ type: "website", name?, settings? { title, buttonText, successMessage, redirectUrl, allowedOrigins[] (https://site, no path), askFor { email, company, city, product, message } } }` |
| `PATCH` | `/lead-sources/:id` | `{ name?, status? (active/paused), settings? }` (settings are merged). |
| `DELETE` | `/lead-sources/:id` | Soft delete; a website form stops working at once. |
| `GET` | `/lead-sources/:id/intakes?limit=` | The latest enquiries: `{ source, sourceRef, outcome (created/attached/rejected/failed/processing), reason, summary, leadId, contactId, receivedAt, raw }`. |

### Website enquiry form (public, no sign-in)

Callable from any website (CORS without cookies); a form with `allowedOrigins` refuses other sites (403 `ORIGIN_NOT_ALLOWED`). Own rate limit per address (`RATE_LIMIT_FORM_PER_MINUTE`, default 10).

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/public/forms/:publicKey/embed.js` | The script that draws the form into `<div data-yellow-crm-form="<publicKey>">` (or after the script tag). |
| `POST` | `/public/forms/:publicKey` | `{ name, phone, email?, company?, city?, product?, quantity?, message?, submissionId? }` as JSON → 201 `{ accepted, message }`; as a plain HTML form → a thank-you page or a 303 to `redirectUrl`. Needs a valid mobile number or an email. `submissionId` makes a double click count once. The hidden `website_url` field is a honeypot (filled in → accepted but dropped). Paused forms: 403 `FORM_PAUSED`. |

### How enquiries become leads

Every source goes through the same intake: the same enquiry (organization + source + the source's own id) is taken once; the contact is found by mobile number (+91 by default), else email, and its blank details are filled in; if the contact has an open lead the enquiry is added to it as an "Enquiry" activity and its follow-up moves to now (D26); otherwise a New lead is created with `source`, `sourceRef`, title (the product asked for), `productId` when a product of that name exists, and quantity. Each enquiry is kept in the intake log with its raw payload (up to 20 KB).

## Idempotency

`POST` endpoints that accept `Idempotency-Key` (8–128 characters) return the stored response for a repeated key with the same body (header `Idempotent-Replayed: true`), `422 IDEMPOTENCY_KEY_REUSED` for a different body, and `409 IDEMPOTENCY_IN_PROGRESS` while the first request is still running. Records expire after 24 hours.

## Planned

Phase 2 ends with the final checks (checkpoint G); then WhatsApp, lead sources, GST quotations, orders, broadcasts and payments. See [BIZNUMA_ROADMAP.md](BIZNUMA_ROADMAP.md) section 6 for the full endpoint plan.
