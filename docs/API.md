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
| `GET` | `/contacts?q=&lifecycle=lead\|customer&status=&ownerId=&tag=&consent=unknown\|opted_in\|opted_out&sort=&page=&limit=` | Search name/email/phone/company/city. Each contact has `consent { marketing (unknown/opted_in/opted_out), changedAt, method (manual, import, whatsapp_reply) }`. |
| `POST` | `/contacts` | `{ name, email?, phone?, company?, gstin?, state?, city?, address?, tags?, source?, lifecycle?, status?, productIds?, notes?, ownerId?, marketingConsent? (unknown/opted_in/opted_out; PATCH too) }`. The phone is stored as entered and as E.164 (`+91` added to 10-digit numbers); an invalid phone is 400 `INVALID_PHONE`, a number that another contact has is 409 `DUPLICATE_CONTACT`. |
| `GET/PATCH/DELETE` | `/contacts/:id` | Delete is a soft delete and frees the phone number. |
| `POST` | `/contacts/import/preview` | Multipart `file` (CSV, up to 5 MB and 10,000 rows; comma or semicolon; a UTF-8 BOM is fine) → `{ headers, rows (first 5), totalRows, mapping (a field per column guessed from the header: "Mobile No" → phone, "Party Name" → name, "GST No" → gstin …, or ""), fields }`. Excel files: 400 `UNSUPPORTED_FILE` ("save as CSV UTF-8"). |
| `POST` | `/contacts/import` | Multipart `file` and fields `mapping` (JSON list, one of `fields` or "" per column; a phone or email column is required: 400 `PHONE_REQUIRED`), `tags` ("a, b" for everyone), `lifecycle` (customer/lead), `consent` (opted_in = "they agreed to WhatsApp offers"; never overrides an opt-out), `updateExisting` (default true), `dryRun`. Phones become E.164 (+91 for 10 digits); rows of the file with the same phone (else email) merge; a contact already in the CRM gets its blank fields filled and the tags (agents only their own contacts). → `{ totalRows, created, updated, unchanged, mergedInFile, rejected, rejectedRows [{ row, text }], warnings [{ row, text }], dryRun }` (row numbers as in the spreadsheet). New contacts: source from the file or Import, owner = the importer. |

**Opt-out on WhatsApp (D35)**: a customer message that is only STOP, UNSUBSCRIBE, STOP ALL, OPT OUT or the "Stop promotions" button opts them out of marketing (`consent.method: whatsapp_reply`, a "Consent" note on their lead, a confirmation inside the 24-hour window); START, SUBSCRIBE or OPT IN opts them back in. The FAQ bot does not answer those messages. Marketing templates (workflows, sequences, auto-replies) and broadcasts skip opted-out customers.

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
| `POST` | `/leads/:id/quotations` | Phase 2 lead form: `{ items: [{ productId?, name?, quantity, unitPricePaise, discountPaise?, taxRatePct? }], validUntil? }` — creates the lead's draft quotation (201) or updates it (200), priced like `POST /quotations`. |

### Quotations, estimates, proforma invoices (Phase 5)

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/quotations?leadId=&contactId=&status=&type=&q=` | `q` searches the number and the customer's name or company. List items leave out `revisions`. |
| `POST` | `/quotations` | `{ leadId \| contactId \| conversationId, type? (Quotation, Estimate, Proforma Invoice), items, billTo?, placeOfSupplyCode?, zeroRated?, validUntil?, terms?, notes? }` → 201. A chat's quotation is for its customer and their newest open lead. Accepts `Idempotency-Key`. |
| `GET` | `/quotations/:id` | With `revisions[]` (earlier versions). |
| `PATCH` | `/quotations/:id` | Content (the fields of POST except the customer and type) — drafts only, else 409 `NOT_DRAFT`; and/or `{ status: Sent \| Accepted \| Rejected, rejectedReason? }` (409 `INVALID_STATUS` for other moves; Accepted can go back to Sent while no order exists). |
| `POST` | `/quotations/:id/revise` | Sent, Viewed, Rejected or Expired → a new revision as a Draft; the old version goes to `revisions` (409 `NOT_REVISABLE` for drafts and accepted ones). |
| `DELETE` | `/quotations/:id` | Soft delete (not when an order was made from it). |
| `POST` | `/pricing/preview` | The editor's live totals: the body of POST (customer and items optional), nothing saved → `{ items, totals, supply (with warnings), billTo, defaults { terms, validUntil } }`. With only a customer it returns their details and the document defaults from Settings → Billing (which agents cannot read directly). |
| `GET` | `/pricing/states` | The GST state codes `[{ code, name }]` for the editor's lists. |
| `GET` | `/quotations/:id/pdf` | The PDF (attachment, e.g. `QT-2026-27-0001-R1.pdf`): logo, seller and customer details, place of supply, items with HSN/SAC, discount, taxable value and GST rate, totals with CGST + SGST/UTGST or IGST and the round-off, the amount in words, a GST summary by rate, bank details, a UPI QR code (the full amount on a proforma invoice, no amount on a quotation or estimate), terms, notes, a signature line, page numbers and the online link; "DRAFT" across drafts. |

Every quotation has a `shareUrl`: `<PUBLIC_URL>/q/<id>.<signature>` (an HMAC made with a key derived from `JWT_SECRET`; nothing stored, cannot be guessed or changed).
| `GET` | `/quotations/:id/send-options` | Needs `inbox` too. `{ blocked (why it cannot go, or ""), phone, account, conversation { id, windowOpen } \| null, caption (suggested message with the link), templates [approved templates of that number that the CRM can send, each with documentHeader and suggested values: the customer's name, the number, the total, the link — or, for a URL button ending in /q/{{1}}, the link's token] }`. |
| `POST` | `/quotations/:id/send` | Needs `inbox` too; accepts `Idempotency-Key`. `{ mode: "document", caption? }` — the PDF with a caption, only while the customer's 24-hour window is open (422 `WINDOW_CLOSED`); `{ mode: "template", templateId, variables }` — any time: a template with a DOCUMENT header carries the PDF (Meta allows only PDFs there), a text template goes without it. The customer's latest chat is used (or one is opened on the default number and assigned to the sender). A draft becomes Sent (`sentVia: whatsapp`) and a New/Contacted lead moves to Quote Sent; a resend keeps the status and notes "sent again on WhatsApp". 409 `NO_PHONE`, `REVISE_FIRST` (rejected or expired), `CHAT_ASSIGNED` (a teammate's chat); 502 `WHATSAPP_REFUSED` when WhatsApp refuses (the attempt shows in the chat, the quotation stays as it was). → `{ quotation, message, conversationId }`. |

Templates now report `documentHeader`. Such templates are not sendable from the inbox picker (`sendable: false`, reason "send it from a quotation") — only from a quotation, which supplies the PDF.

#### The customer's link (public, no sign-in)

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/q/<id>.<signature>` | An HTML page for any phone: the quotation, totals in words, bank details, UPI QR and "Pay with UPI" link, terms, "Download PDF". Opening it counts a view (`viewCount`, `lastViewedAt`, first `viewedAt`); the first view of a Sent quotation makes it Viewed and adds "opened by the customer" to the lead. `?preview=1` (the CRM's "Open customer view") does not count. A draft shows "being updated"; a deleted quotation or a wrong signature is 404. Strict headers: no scripts (CSP `default-src 'none'`), no framing, `noindex`, `no-store`; 60 requests a minute per address. |
| `GET` | `/q/<id>.<signature>/pdf` | The same PDF, shown inline (not for drafts). |

Items: `{ productId? , name?, description?, hsnSac?, unit?, quantity, unitPricePaise?, discountType (amount \| percent), discountValue (paise or %), gstRatePct? }` — missing values come from the product. The server computes everything in paise: quantity × price, minus the discount = taxable value; GST per line on the taxable value, rounded to the paisa; same state as the organization → CGST + SGST (UTGST in Chandigarh, Ladakh, Lakshadweep, Andaman and Nicobar, Dadra and Nagar Haveli and Daman and Diu), else IGST; `zeroRated` (export/SEZ under LUT) → no GST; the grand total is rounded to the rupee (`roundOffPaise`) when Settings → Billing says so (D28). The place of supply: `placeOfSupplyCode` if chosen, else the customer's GSTIN, else their state; unknown → the organization's state, with `supply.stateAssumed` and a warning (D30). `totals.byRate[]` summarizes each rate. Numbers: `<prefix>/<financial year>/<0001>`, each type counted on its own (default prefixes QT, EST, PI). Sending (status Sent) moves a New or Contacted lead to Quote Sent. Sent and Viewed quotations past `validUntil` become Expired (hourly job).

### Billing settings (owners and admins)

| Method | Route | Purpose |
| --- | --- | --- |
| `GET/PUT` | `/organization/billing` | `{ bank { accountName, accountNumber, ifsc, bankName, branch }, upiId, terms, validityDays (default 15), prefixes { quotation, estimate, proforma, order }, roundOff (default true), reduceStockOnDispatch }`. GET also returns the GST state used for quotations (`stateCode`, `state`, `stateFrom`: gstin \| address), which comes from the company profile. Prefixes must differ. |

### "Quote Sent, no reply"

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/quotations/awaiting-reply?days=3` | Leads at Quote Sent whose latest Sent/Viewed quotation went out at least `days` (1–60, default 3) ago and the customer has not written on WhatsApp since: `[{ lead, quotation { id, type, number, status, sentAt, viewCount, lastViewedAt, grandTotalPaise }, conversationId, waitingDays }]`, longest wait first. |

### Orders (Phase 5)

Same permissions as leads and quotations; agents see the orders of their own leads.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/orders?stage=&contactId=&leadId=&q=` | `q` searches the order and quotation numbers, the customer and the LR number. |
| `GET` | `/orders/summary` | `{ counts { <stage>: n }, total }`. |
| `POST` | `/orders` | `{ quotationId }` — from an accepted quotation, once (409 `NOT_ACCEPTED`, `ORDER_EXISTS`); copies its lines, totals and parties; number `<order prefix>/<financial year>/<0001>` (default SO). Accepts `Idempotency-Key`. The quotation can then not be un-accepted or deleted. |
| `GET/PATCH` | `/orders/:id` | PATCH `{ dispatch { transporter, lrNumber, vehicleNumber, expectedDeliveryDate }, notes }`. |
| `POST` | `/orders/:id/stage` | `{ stage, note?, cancelReason?, dispatch? }`. Stages: Received → Processing → Dispatched → Delivered → Payment Collected (any step, forwards or back), or Cancelled (reason required, 422 `CANCEL_REASON_REQUIRED`; not once paid, 409 `ORDER_PAID`; final, 409 `ORDER_CANCELLED`). Dispatched stamps `dispatch.dispatchedAt`, Delivered `deliveredAt`, Payment Collected `paidAt` and wins the lead (the contact becomes a customer). With "reduce stock on dispatch" the products' stock goes down once (never below 0) when the order reaches Dispatched or later, and comes back if it is cancelled or moved back. Each move goes to `history` and the lead's timeline. |
| `GET` | `/orders/:id/notify-options` | Needs `inbox` too. `{ blocked, windowOpen, text (a ready message for the stage), templates [with suggested values: name, order number, stage, transporter + LR] }`. |
| `POST` | `/orders/:id/notify` | Needs `inbox` too. `{ mode: "text", text }` (24-hour window open, else 422 `WINDOW_CLOSED`) or `{ mode: "template", templateId, variables }`; marks the latest history entry `notified`. |

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

### Workflows (Phase 6: the automation engine)

Module: `automation` (read, create, edit; delete needs `automation:delete` for agents). A workflow is "when <trigger>, only if <conditions>, then <steps>". Active workflows run on their own in background jobs; each start is a run with a log line per step. `stats` are kept by the server.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/workflows/meta` | What the builder offers: `triggers [{ type, label, kind: event \| time }]`, `conditions [{ field, label, ops }]`, `actions [{ type, label }]`, `sequenceSteps`, `variableValues`, `placeholders`, `leadStages`, `orderStages`, `sources`, `runStatuses`. |
| `GET` | `/workflows?q=&status=&ownerId=&sort=&page=&limit=` | Each `{ id, name, status, trigger { type, params }, conditions[], steps[], notes[], hasWebhook, ownerId, stats { runs, done, failed, lastRunAt } }`. `notes` lists what migration 003 or the importer could not carry over. |
| `POST` | `/workflows` | `{ name, status? (Active by default, Paused, Draft), ownerId?, trigger, conditions? (up to 10), steps (1–20) }`, see below. 400 `VALIDATION_ERROR` names the place, e.g. `errors[0].field = "steps.1"` and "Step 2 (WhatsApp template): Template is required"; checks against your data give `INVALID_MEMBER`, `MEMBER_NO_LEADS`, `INVALID_TEMPLATE`, `TEMPLATE_NOT_SENDABLE` (not approved, authentication, document or media header), `VARIABLE_REQUIRED` and `WEBHOOK_URL`. |
| `GET/PATCH/DELETE` | `/workflows/:id` | GET also returns `webhookSecret` to owners and admins. PATCH any field; turning on a workflow without steps is 400 `STEPS_REQUIRED`. Pausing or deleting a workflow stops its running and waiting runs (`cancelled`). Delete is a soft delete. |
| `POST` | `/workflows/:id/run` | Test run: `{ leadId }` (a lead you can see) → 202 with the run, started now whatever the trigger (`trigger: "manual"`). The steps really happen. 409 `NOT_ACTIVE` unless Active. Send an `Idempotency-Key`. |
| `GET` | `/workflows/:id/runs?status=&leadId=&page=&limit=` | That workflow's runs, newest first. |
| `GET` | `/automation-runs?workflowId=&leadId=&status=&page=&limit=` | Every run (agents without `automation:view_all`: their own workflows' runs). Each `{ id, workflowId, workflowName, trigger, event (a short summary: source, from/to, text …), subject { leadId, contactId, conversationId, orderId, quotationId, taskId, label }, status (running/waiting/done/failed/skipped/cancelled), steps [{ index, type, label, status (done/skipped/failed/waiting), detail, at }], nextAt, error, createdAt, finishedAt }`. |
| `GET` | `/automation-runs/:id` | One run. |
| `POST` | `/automation-runs/:id/cancel` | Stops a running or waiting run; a waiting step becomes skipped. 409 `RUN_FINISHED` otherwise. |

**Triggers** (`trigger.type` and `params`): `lead.created` { sources[] } (manual leads, lead sources, first WhatsApp messages); `message.received` { keywords[] } (any word, capitals ignored); `lead.stage_changed` { toStages[], fromStages[] } (by a person, a quotation being sent, an order being paid or another workflow); `order.stage_changed` { toStages[] }; `payment.received` (an order moves to Payment Collected); and three found by a scan every 10 minutes, each once per thing: `lead.no_reply` { hours 1–720, default 24 } (our message was the last one in the chat, up to 7 days back), `quotation.not_accepted` { days 1–90, default 3 } (still Sent or Viewed; once per revision), `task.overdue` (not done, due in the last 30 days; once per due date). Empty lists mean "any".

**Conditions** (`{ field, op, value }`, all must hold): `source` in / notIn [sources]; `stage` in / notIn [stages]; `tag` has / hasNot "tag" (the customer's tags, capitals ignored); `owner` is / isNot memberId, none, any; `businessHours` open / closed (Settings → Lead rules).

**Steps** (`{ type, params }`, in order): `whatsapp.text` { text } (only inside the 24-hour window, else skipped); `whatsapp.template` { templateId, variables { header, body, buttons } } (each variable a CRM value from `variableValues` or `text:<words>`; a value the customer does not have — no company, a lead without a title — skips the step; a marketing template skips opted-out customers; the chat is opened if needed and goes to the lead's owner); `assign` { memberId } (lead, unowned customer and unassigned chats); `tag.add` / `tag.remove` { tag }; `stage.change` { stage, lostReason when Lost } (through the same rules as a person: probability, customer on Won, timeline); `task.create` { title, description?, dueInDays 0–365 (default 1), assignTo "owner" or memberId, priority }; `agent.notify` { to "owner" (the lead's owner, else the task's assignee, else owners and admins) \| "managers" \| memberId, message } (the bell); `wait` { amount, unit minutes/hours/days } (at most 90 days); `webhook.call` { url } (public https only, checked again on every call; no redirects; 10 s timeout); `sequence.enroll` { sequenceId } (the customer and their lead; skipped while they are already in it or the sequence is not Active; 400 `INVALID_SEQUENCE` on save for another organization's sequence). Texts, task titles and notifications may use `{{contact.name}}`, `{{contact.company}}`, `{{contact.city}}`, `{{contact.phone}}`, `{{lead.title}}`, `{{lead.stage}}`, `{{lead.source}}`, `{{owner.name}}`, `{{org.name}}`, `{{order.number}}`, `{{order.stage}}`, `{{order.total}}`, `{{quotation.number}}`, `{{quotation.total}}`, `{{task.title}}`, `{{task.due}}`, `{{message.text}}`.

**Webhook calls** are `POST` JSON `{ event, at, workflow { id, name }, run { id }, lead, contact, order, quotation, task, message }` (unknown parts are `null`) with `X-CRM-Event` and `X-CRM-Signature: sha256=<HMAC-SHA256 of the raw body with the workflow's webhookSecret>`.

**How runs behave**: a run sees the records as they are when each step runs. Messages, tasks and stage changes it makes are by `Automation "<workflow name>"` (messages carry `automation: { kind: "workflow", ruleId }` and never take the chat). A refused step (4xx: e.g. a template that was removed) fails the run at once; other errors are retried up to 4 times. Events caused by an automation may start other workflows, but never the same workflow again and at most 4 in a row.

### Sequences (Phase 6B: follow-ups per customer)

Module: `automation` (read, create, edit; delete needs `automation:delete` for agents; agents see their own sequences unless `automation:view_all`). A sequence is a list of steps on days after a customer is added; each customer added is an **enrollment** with its own schedule and log.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/sequences?q=&status=&ownerId=&sort=&page=&limit=` | Each `{ id, name, status, steps [{ day, type, params }], stopOnReply, stopOnClose, workingHoursOnly, notes[], ownerId, stats { enrolled, active, completed, stopped, failed, lastEnrolledAt } }`. |
| `POST` | `/sequences` | `{ name, status? (Active by default), ownerId?, steps (1–30): [{ day 0–365, type, params }], stopOnReply? (default true), stopOnClose? (default true), workingHoursOnly? (default true) }`. Step types: `whatsapp.text`, `whatsapp.template`, `task.create`, `agent.notify`, `tag.add`, `tag.remove`, `stage.change`, `assign` (params as for workflow steps, checked the same way); no waits (the days are the waits), webhooks or sequences. Steps are kept in day order. |
| `GET/PATCH/DELETE` | `/sequences/:id` | Turning on without steps is 400 `STEPS_REQUIRED`. Pausing or deleting stops everyone in it. Soft delete. |
| `POST` | `/sequences/:id/enroll` | `{ leadId }` (its customer) or `{ contactId }` (with their open lead, if any) → 201 enrollment. 409 `NOT_ACTIVE`, 409 `ALREADY_ENROLLED` while the customer is in it; 404 for a lead or customer you cannot see. Send an `Idempotency-Key`. |
| `GET` | `/sequences/:id/enrollments?status=&page=&limit=` | Who is or was in it, newest first. |
| `GET` | `/sequence-enrollments?sequenceId=&contactId=&leadId=&status=&page=&limit=` | Each `{ id, sequenceId, sequenceName, contactId, leadId, label, status (active/completed/stopped/failed), enrolledAt, enrolledBy { kind member\|workflow, name, workflowId }, stepIndex (the next step), nextAt, steps [{ index, day, type, status done/skipped/failed, detail, at }], stopReason, error, finishedAt }`. |
| `GET` | `/sequence-enrollments/:id` | One. |
| `POST` | `/sequence-enrollments/:id/stop` | Takes the customer out (`stopReason` "Stopped by <name>."). 409 `ENROLLMENT_FINISHED` otherwise. |

**Timing**: day N is due N days after the customer was added (day 0 at once); with `workingHoursOnly` a step due outside working hours (Settings → Lead rules) waits for the next opening. **Stopping**: with `stopOnReply` any WhatsApp message from the customer after they were added stops it ("The customer replied on WhatsApp."; a workflow that adds them on that very message starts a fresh round); with `stopOnClose` their lead being won or lost stops it. Each step checks both again before it runs. A refused step (4xx, e.g. a template Meta paused) is logged as failed and the sequence carries on with the next step; other errors are retried, and if they persist the customer's sequence fails. Messages carry `automation: { kind: "sequence", ruleId }`; tasks, notes and stage changes are by `Sequence "<name>"`. Someone who completed or stopped can be added again.

The `automation` module alone does not allow `POST /tasks`; automation tasks come from workflow and sequence steps.

### Segments (Phase 7; owners and admins)

A segment is a saved audience, worked out each time it is used. All filled-in filters must match; text filters ignore capitals. Opted-out customers are never in a segment (D35).

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/segments` | Saved segments with `count` (customers now). |
| `GET` | `/segments/options` | Tags, states, cities and product categories in use (for the builder). |
| `POST` | `/segments/preview` | `{ filters }` → `{ total, withWhatsApp (have a mobile number), optedOut (left out for having opted out), sample (10) }`. |
| `POST` | `/segments` | `{ name, description?, filters: { tagsAll[], tagsAny[], tagsNone[], states[], cities[], sources[], lifecycles[], ownerIds[], productIds[] (interested in, or a lead for), productCategories[], leadStages[] (has a lead in), consent (not_opted_out default, or opted_in = only those who agreed) } }`. Owners and products must be the organization's (`INVALID_MEMBER`, `INVALID_PRODUCT`). |
| `GET/PATCH/DELETE` | `/segments/:id`; `GET /segments/:id/preview` | |

### WhatsApp broadcasts (Phase 7; owners and admins)

A broadcast sends one approved template (variables filled per customer, as in workflow steps: a CRM value or `text:…`) to a segment. Starting it fixes the recipients: the segment's customers with a mobile number who have not opted out (D35). Messages go in batches of 20 a second while Meta's daily limit allows (D38): Meta counts the different people who got a template in the last 24 hours; when the number's tier (`TIER_250` … `TIER_UNLIMITED`, read from Meta when the number is checked; unknown = 250) is used up, the rest waits (`waitUntil`). The plan allows a number of broadcasts a month (India time, D34).

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/broadcasts?status=&page=&limit=` | Newest first, each with `stats { total, pending, sent, delivered, read, replied, failed, skipped }` (delivered includes read and replied; read includes replied). |
| `GET` | `/broadcasts/quota` | `{ plan, limit, used, left }` this month. |
| `POST` | `/broadcasts` | `{ name, templateId, variables, segmentId }` → a draft. The template must be sendable (`TEMPLATE_NOT_SENDABLE`, not a document-header one) and every variable given (`VARIABLE_REQUIRED`); `INVALID_SEGMENT`. |
| `GET/PATCH/DELETE` | `/broadcasts/:id` | PATCH while draft or scheduled (409 `BROADCAST_STARTED`); DELETE drafts and cancelled ones only. |
| `GET` | `/broadcasts/:id/estimate` | `{ recipients, cost { perMessagePaise, paise, gstPaise, totalPaise, currency, asOf }, quota, dailyLimit { limit, tier, usedToday, leftToday } }`. The cost uses Meta's per-message rates for India by template category (constants/whatsappPricing.js, D37) — an estimate; Meta's invoice is what counts. |
| `POST` | `/broadcasts/:id/send` | `{ scheduledAt? }` (a future time, else now). 409 `QUOTA_REACHED`, 409 `EMPTY_AUDIENCE`. Send an `Idempotency-Key`. |
| `POST` | `/broadcasts/:id/pause`, `/resume`, `/cancel` | Cancel skips the recipients still pending. |
| `GET` | `/broadcasts/:id/recipients?status=&page=&limit=` | `{ name, phone, status (pending/sent/delivered/read/replied/failed/skipped), reason, conversationId, sentAt, deliveredAt, readAt, repliedAt, failedAt }`. |

Each message goes into the customer's chat (opened if needed, for the customer's owner) with `automation: { kind: "broadcast", ruleId }`. A recipient is skipped when they opted out after the start, have no mobile number any more, or lack a value for a variable ("No value for {{product}}."). WhatsApp's status webhooks move them to delivered / read / failed; a message from them within 7 days marks them replied. When it finishes, whoever started it gets a bell notification.

### WhatsApp FAQ bot (Phase 6C; owners and admins)

The bot answers customers on WhatsApp while **no agent has the chat** and the customer has **not asked for a person** (D33). For each message, in order: a tapped bot button or list row; a hand-off keyword; the first active answer (by `priority`) with a keyword in the message (whole words or phrases, any script, capitals ignored); outside working hours the away message, otherwise the greeting — each of those two at most once per chat every `repeatAfterHours`. Bot messages carry `automation: { kind: "bot", ruleId? }`. Only inside the 24-hour window (the customer has just written).

An **answer** is `{ text (≤ 1024, may use {{contact.name}}, {{org.name}}, {{owner.name}}, {{lead.title}} …), options (0–10): [{ title, description?, action: rule | handoff, ruleId (rule) }], listButton (≤ 20, default "Choose"), footer (≤ 60) }`. No options: a text message; 1–3: reply buttons (titles ≤ 20, unique); 4–10: a list (row titles ≤ 24, descriptions ≤ 72), as WhatsApp allows. Option ids are `bot:rule:<id>` and `bot:handoff`; options to an answer that was removed or switched off are left out when sending.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/bot/status` | Any member: `{ enabled }` (the Inbox shows the bot in each chat). |
| `GET/PUT` | `/bot/settings` | `{ enabled (default false), greeting { enabled, answer }, away { enabled, answer }, handoff { keywords[] (default agent, human, person, talk to someone, call me, baat karni hai), text }, repeatAfterHours (1–168, default 24) }`. PUT takes any part. 400 `INVALID_RULE` for an option opening another organization's answer. |
| `GET` | `/faq-rules` | The answers by priority: `{ id, name, active, priority, keywords[], answer, stats { answered, lastAnsweredAt } }`. |
| `POST` | `/faq-rules` | `{ name, active?, priority?, keywords? (up to 30; none = only reachable from another answer's option), answer }`. |
| `PATCH/DELETE` | `/faq-rules/:id` | |
| `POST` | `/conversations/:id/bot` | Inbox (edit): `{ active }` — false: the bot stops in this chat ("Paused by <name>"); true: it answers again. |

**Hand-off**: the bot replies with the hand-off text, sets the chat's `bot.handedOffAt` (`bot.handoffReason`), and rings the bell of the customer's owner (else the owners and admins) with a link to the chat. It stays quiet there until a teammate turns it on again or closes the chat. Chats also show `bot { handedOffAt, handoffReason }` in the conversation API. When the bot's greeting is on, auto-reply rules skip enquiries that came in on WhatsApp ("No auto-reply: the WhatsApp bot greets customers who write on WhatsApp.").

### Notifications (the bell; every member)

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/notifications?unread=&limit=` | The signed-in member's own: `{ items [{ id, title, body, link, source, readAt, createdAt }], unread }`, newest first (limit up to 50). Kept 90 days. |
| `POST` | `/notifications/:id/read` | Marks one read (404 for someone else's). |
| `POST` | `/notifications/read-all` | `{ updated }` |

### Moving browser data to the server

| Method | Route | Role | Purpose |
| --- | --- | --- | --- |
| `POST` | `/imports/localstorage` | owner, admin | `{ data: { crm_products: "<json>", ... }, dryRun }` (up to 25 MB). Imports products, customers, accounts, leads, deals (as leads), lead activities, quotations, tasks, deal follow-ups (as tasks with origin `deal_followup`), calendar events, support tickets (old numbers kept when free, otherwise renumbered with `legacyNumber`), ticket replies, customer notes and documents (browser files go to private storage; links get `https://` when it was missing; bad links and programs are reported), campaigns (budget → paise, notes → campaign notes), workflows (in the Phase 6 shape and paused, D32; what has no equivalent is reported and kept in the workflow's `notes`) and sequences (likewise in the Phase 6B shape and paused: calls and tasks become task steps, emails notes; old run/enroll counts kept) and Account Champions (`crm_agents`, as pending invites; see MIGRATION.md); contacts are matched by phone, then email (deals: name + company). Task and event assignees are matched to team members by name, else the name is kept; related records are matched by name among imported and existing ones. Old ids are kept, so running it again creates nothing new (and records deleted on the server are not brought back). Returns a report per section (`found, created, alreadyImported, merged, rejected`, and `rejectedRows` with the reasons), `unresolved` notes and `later` (keys that move in a later update). `dryRun: true` writes nothing. |
| `GET` | `/imports/:id` | owner, admin | A previous run and its report. |
| `GET` | `/exports/crm` | owner, admin | "Download CRM Data": one JSON file (`crm-export-YYYY-MM-DD.json`, streamed) with `organization`, `team` (name, email, role, title, access; no tokens) and every record of `contacts, products, leads, leadActivities, quotations, tasks, events, tickets, notes, documents, campaigns, workflows, sequences`. Deleted records, secrets and internal fields (`organizationId`, `storageKey`, `deletedAt`, workflows' `webhookSecret`) are left out; uploaded files are not included. |

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

Same address as the API (path `/socket.io`; the browser client is served at `/socket.io/socket.io.min.js`). Connect with `auth: { token: <access token> }`; members without the inbox get `FORBIDDEN`, bad tokens `UNAUTHORIZED`. Events (server → browser), only for chats the member may see: `conversation:updated` (a conversation), `message:new` (`{ conversation, message }`), `message:status` (a message; also sent when a received file has been stored), `note:new` (`{ conversationId, note }`), and `notification:new` (a notification, to its member only; D31: members without the inbox see new ones within a minute through `GET /notifications`). When a member's role, pages or status change (or they are removed) their connections are dropped; the browser reconnects with its current token and gets the new access.

### Development only (404 when `NODE_ENV=production`)

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/dev/simulate/lead` | Owners/admins. `{ source? (default IndiaMART), sourceRef?, name, phone, email?, company?, city?, state?, product?, quantity?, message? }` → the same intake as a real lead; returns `{ outcome, leadId, contactId, contactCreated }` (400 `LEAD_REJECTED` without a valid mobile number or email). |
| `POST` | `/dev/simulate/whatsapp-inbound` | Owners/admins. `{ from, name?, type? (text/image/document/audio/interactive), text, replyId? (interactive), accountId? }` → processes a made-up incoming message exactly like a webhook (photos, documents, voice notes and button taps only on test numbers; media get a sample file and `text` is the caption; `interactive` is a tapped reply button with id `replyId` and title `text`); returns `{ conversationId, messageId, contactId }`. |

## Lead sources (Phase 4)

### Connections (Settings → Lead sources, owners and admins)

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/lead-sources` | `{ id, type (website, indiamart, facebook, googleads, justdial, tradeindia), source, name, status (active/paused/error), statusMessage, settings, stats { received, created, attached, duplicate, rejected }, lastLeadAt, lastError, credentials { configured, hint (last 4) }, form? { publicKey, submitUrl, embedUrl }, pushUrl? (IndiaMART), lastPulledUntil? }`. Keys and tokens are never returned; values to paste elsewhere are: Facebook `verifyToken` and `settings { pageId, pageName }`, Google Ads `googleKey`. |
| `POST` | `/lead-sources` | Website form: `{ type: "website", name?, settings? { title, buttonText, successMessage, redirectUrl, allowedOrigins[] (https://site, no path), askFor { email, company, city, product, message } } }`. IndiaMART: `{ type: "indiamart", name?, apiKey (CRM API key), settings? { queryTypes: ["W","B","P","WA","BIZ"] } }` (default W, B, P, WA) — starts pulling at once. Facebook: `{ type: "facebook", pageId, pageAccessToken (long-lived), appSecret }` — the token is checked and the Page subscribed to leadgen (Facebook's error → 400, nothing saved). Google Ads, JustDial, TradeIndia: `{ type }`. |
| `PATCH` | `/lead-sources/:id` | `{ name?, status? (active/paused), apiKey? (IndiaMART), pageAccessToken? / appSecret? (Facebook; a new token is checked), settings? }` (settings are merged). A new key or token re-activates a refused source. Pausing stops pulls; paused push sources answer 200 and drop leads. |
| `POST` | `/lead-sources/:id/pull` | IndiaMART: pull now → `{ called, fetched, outcomes { created, attached, duplicate, skipped, rejected }, connection }`; within 5 minutes of the last call 429 `TOO_SOON` with the minutes to wait. |
| `DELETE` | `/lead-sources/:id` | Soft delete; a website form stops working at once. |
| `GET` | `/lead-sources/:id/intakes?limit=` | The latest enquiries: `{ source, sourceRef, outcome (created/attached/rejected/failed/processing), reason, summary, leadId, contactId, receivedAt, raw }`. |

### Website enquiry form (public, no sign-in)

Callable from any website (CORS without cookies); a form with `allowedOrigins` refuses other sites (403 `ORIGIN_NOT_ALLOWED`). Own rate limit per address (`RATE_LIMIT_FORM_PER_MINUTE`, default 10).

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/public/forms/:publicKey/embed.js` | The script that draws the form into `<div data-yellow-crm-form="<publicKey>">` (or after the script tag). |
| `POST` | `/public/forms/:publicKey` | `{ name, phone, email?, company?, city?, product?, quantity?, message?, submissionId? }` as JSON → 201 `{ accepted, message }`; as a plain HTML form → a thank-you page or a 303 to `redirectUrl`. Needs a valid mobile number or an email. `submissionId` makes a double click count once. The hidden `website_url` field is a honeypot (filled in → accepted but dropped). Paused forms: 403 `FORM_PAUSED`. |

### IndiaMART

- **Pull** (CRM Pull API v2): a job per connection every 5½ minutes (IndiaMART allows one call per 5 minutes; an atomic "last call" stamp keeps that across workers and "Pull now"). The first window is the last 24 hours; later windows start 5 minutes before the previous end; never more than 7 days. Times are sent in IST (`DD-MM-YYYYHH:MM:SS`). CODE 401 → the source goes to `error` ("paste a new key") and stops; 429 and other errors keep the cursor, so the next pull catches up.
- **Push** (public): `POST /webhooks/leads/indiamart/<key>` with IndiaMART's `{ CODE, STATUS, RESPONSE: { UNIQUE_QUERY_ID, … } }` → 200 (also for repeats and while paused, so IndiaMART never switches the push off; paused leads are dropped); unknown key 404; not JSON 400. IndiaMART signs nothing: the random key in the address is the secret, and it is masked in the request log.
- Each lead: `sourceRef` = `UNIQUE_QUERY_ID`; name (or the company when IndiaMART only says "IndiaMART Buyer"), mobile (else alternate mobile/phone), email, company, city, state, address; product = `QUERY_PRODUCT_NAME` (else category); the enquiry text starts with the kind of lead (Direct enquiry, Buy-lead, Phone call (PNS), WhatsApp enquiry, Catalogue view); `QUERY_TIME` (IST) is when it was received.

### Facebook Lead Ads, Google Ads, JustDial, TradeIndia (public webhooks)

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/webhooks/leads/facebook/<key>` | Meta's handshake: `hub.verify_token` must be the connection's verify token → the challenge, else 403. |
| `POST` | `/webhooks/leads/facebook/<key>` | Page `leadgen` notifications, signed with the app secret (`X-Hub-Signature-256`, else 401). Each `leadgen_id` of the connected Page becomes a job that reads `GET /<leadgen_id>?fields=id,created_time,ad_id,form_id,field_data` with the Page token (retried; one job per lead). Standard questions (full_name, first/last_name, email, phone_number, city, state, company_name, street_address, zip/post code) fill the contact; other questions go into the enquiry; the form's name is the lead title. Facebook refusing the token (4xx) sets the source to `error` and stops. |
| `POST` | `/webhooks/leads/googleads/<key>` | Google Ads lead form JSON. `google_key` must equal the connection's key (else 400, which Google does not retry). `lead_id` is the sourceRef; column ids FULL_NAME, FIRST/LAST_NAME, EMAIL, WORK_EMAIL, PHONE_NUMBER(_VERIFIED), WORK_PHONE, CITY, REGION, COMPANY_NAME, STREET_ADDRESS, POSTAL_CODE fill the contact, other columns go into the enquiry. `is_test` leads are logged ("Google Ads test data") but not added. Answers `{}`. |
| `GET`/`POST` | `/webhooks/leads/justdial/<key>`, `/webhooks/leads/tradeindia/<key>` | No public format exists: query string, form fields or JSON (one lead, or a list under data/leads/response/…) are read, and the usual field names are recognised (name, mobile/phone, email, company, city, state, product/category/subject, message/requirement, lead/enquiry id). Without an id the content itself dedupes retries. Unreadable leads are kept in the log with their raw data. Answers `OK`. |

### Assignment and auto-reply rules (owners and admins)

After an enquiry is taken (or a first WhatsApp message makes a lead), a job assigns it and then sends the auto-reply. Rules look at the source of that enquiry.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET/PUT` | `/organization/business-hours` | `{ timezone (IANA, default Asia/Kolkata), days [0 Sun … 6 Sat], start "HH:MM", end "HH:MM" }` (end after start). GET (anyone) also returns `openNow`; PUT owners/admins. Default Mon–Sat 10:00–19:00. |
| `GET/POST` | `/assignment-rules` | `{ name, active, priority (lower first), conditions { sources[], productIds[], states[], cities[] } (empty = any; states/cities ignore case), strategy (round_robin \| specific), memberIds[] (≥ 1, own team), respectWorkingHours, fallbackMemberId }` → with `stats { assigned, lastAssignedAt }`. |
| `PATCH/DELETE` | `/assignment-rules/:id` | Change or remove a rule. |
| `GET` | `/assignment-rules/history?leadId=` | Anyone who may open Leads: the automatic assignments of a lead `{ toMemberId, fromMemberId, ruleId, reason, at }` (also when no rule matched). |
| `GET/POST` | `/auto-reply-rules` | `{ name, active, priority, sources[] (empty = any), onlyNewContacts (default true), maxAgeMinutes (default 60), delaySeconds (0–3600), templateId, variables { header, body, buttons } }` — each template variable must be mapped to `contact.name`, `contact.company`, `contact.city`, `lead.product`, `owner.name`, `org.name` or `text:<fixed words>` (400 `VARIABLE_REQUIRED`). → with `stats { sent, failed, skipped, lastSentAt }`. |
| `PATCH/DELETE` | `/auto-reply-rules/:id` | Change or remove a rule. |

Assignment: only leads without an owner; the first active rule whose conditions all match decides; round-robin takes one atomic turn per lead among the rule's active people who can open Leads; "respect working hours" sends leads outside the hours to the fallback person (or leaves them unassigned). The lead, its unowned contact and its unassigned WhatsApp chats get the owner; a lead activity "Assigned" and a history entry say why.

Auto-reply: the first active rule for the source; sent by the CRM (`message.automation = { kind: "auto-reply", ruleId }`, no `sentByMemberId`, the chat keeps its assignee) in the chat with the lead's owner; skipped (reason on the lead) for repeat enquiries when `onlyNewContacts`, enquiries older than `maxAgeMinutes`, no mobile number, a template that is no longer approved, and marketing templates to contacts who opted out.

### How enquiries become leads

Every source goes through the same intake: the same enquiry (organization + source + the source's own id) is taken once; the contact is found by mobile number (+91 by default), else email, and its blank details are filled in; if the contact has an open lead the enquiry is added to it as an "Enquiry" activity and its follow-up moves to now (D26); otherwise a New lead is created with `source`, `sourceRef`, title (the product asked for), `productId` when a product of that name exists, and quantity. Each enquiry is kept in the intake log with its raw payload (up to 20 KB).

## Idempotency

`POST` endpoints that accept `Idempotency-Key` (8–128 characters) return the stored response for a repeated key with the same body (header `Idempotent-Replayed: true`), `422 IDEMPOTENCY_KEY_REUSED` for a different body, and `409 IDEMPOTENCY_IN_PROGRESS` while the first request is still running. Records expire after 24 hours.

## Planned

Phase 2 ends with the final checks (checkpoint G); then WhatsApp, lead sources, GST quotations, orders, broadcasts and payments. See [BIZNUMA_ROADMAP.md](BIZNUMA_ROADMAP.md) section 6 for the full endpoint plan.
