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
| `GET` | `/site` | none | Who runs this CRM, for the Privacy Policy and Terms pages (D60): `{ name, email, address, publicUrl }` from `BILLING_SELLER_*`. |
| `GET` | `/health` | none | `{ status, dbState, timestamp }`. 200 when MongoDB is connected, 503 otherwise. `start-crm.vbs` looks for `"dbState"`. Not rate limited. |

## Auth

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/auth/google` | none | Body `{ credential, inviteToken? }`. Verifies the Google ID token, creates the user on first sign-in, accepts pending invites for the verified email, creates an organization only if the user belongs to none. Returns `{ token, user, organizationId, member, memberships, inviteError? }` and sets the refresh cookie — or, on a browser that is not remembered (D58), `{ step: 'whatsapp-code', challenge, phone (the verified number, filled in on the page; '' if none), phoneHint (masked), smsBackup (can the code come by SMS), user { email, name, picture } }` and no session yet. Google alone signs in when `LOGIN_WHATSAPP_CODE=off` or the CRM cannot send codes (`OTP_PROVIDER=off`). |
| `POST` | `/auth/login/code` | none | 2-step verification (D58; optional per person since D60, `LOGIN_WHATSAPP_CODE` optional/required/off). `{ challenge, phone, channel? ('whatsapp' default, or 'sms' — the backup, docs/SMS_SETUP.md) }` → a 6-digit code: `{ sent, channel, message, expiresInSeconds }` (the code is never in an answer; in development it is in the server log); 409 `SMS_OFF` when SMS is not set up. The challenge lives 10 minutes (400 `LOGIN_EXPIRED`). A verified number must match (400 `PHONE_MISMATCH`); a number of another account: 409 `PHONE_IN_USE`. 429 `OTP_TOO_MANY`, 502 `OTP_NOT_SENT`. |
| `POST` | `/auth/login/verify` | none | Step 3. `{ challenge, phone, code, stayLoggedIn? }` → the same as a signed-in `POST /auth/google`; the number is verified the first time. `stayLoggedIn` sets the `crm_device` cookie (httpOnly, SameSite=Strict, path `/api/v1/auth`, 30 days): Google alone on this browser until logout. 401 `OTP_INVALID` / `OTP_LOCKED`. |
| `POST` | `/auth/qr` | none | A computer logged in from a phone (login.html?with=phone, D60; Settings → Your Profile → Log in on another computer): `{ id, secret, image (PNG data URL of …/link-device.html#<id>.<secret>), expiresAt (2 min) }`. |
| `POST` | `/auth/qr/:id/poll` | none | `{ secret, stayLoggedIn? }` → `{ status: pending \| declined \| expired }`, or once `{ status: 'approved', token, user, organizationId, member, memberships }` with the refresh (and device) cookie. 120 per minute per IP. |
| `POST` | `/auth/qr/:id/peek` | bearer | The phone: `{ secret }` → `{ computer ('Chrome on Windows'), askedAt, expiresAt }`; 404 `QR_NOT_FOUND`, 410 `QR_EXPIRED`. |
| `POST` | `/auth/qr/:id/approve` | bearer | The phone: `{ secret, allow (default true) }` → `{ allowed, computer }`; the computer gets the phone user's session in the phone's organization. Audit `auth.computer_linked`. |
| `POST` | `/auth/refresh` | refresh cookie | Rotates the refresh token and returns `{ token, organizationId }`. A token that was already rotated revokes its whole family (`REFRESH_TOKEN_REUSED`). |
| `POST` | `/auth/logout` | refresh cookie | Revokes the session family and clears the cookie. |
| `GET` | `/auth/me` | bearer | `{ user, organization, member, memberships }`. |
| `POST` | `/auth/switch-organization` | bearer | Body `{ organizationId }`. Returns a new access token for another organization the user belongs to. |

`POST /auth/logout` also forgets the remembered browser (`crm_device`).

**Where you're logged in** (Settings → Your Profile, 2026-10-08), like WhatsApp's linked devices:

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/auth/devices` | bearer | `{ devices: [{ id (session family), device ('Chrome on Windows'), method ('google+whatsapp' \| 'google+sms' \| 'qr' \| 'google'), loggedInAt, lastActiveAt, rememberedUntil (or null), current }] }` — this one first. |
| `DELETE` | `/auth/devices/:id` | bearer | Logs that browser or phone out at once and forgets it if remembered → the list; 404 `DEVICE_NOT_FOUND`. Audit `auth.devices_logged_out`. |
| `POST` | `/auth/devices/logout-others` | bearer | Everywhere except this browser → the list. |

Every bearer request checks its session: after a logout (here, from the list, a reused refresh token or removal from the team) the access token is refused at once with 401 `SESSION_ENDED`, not when its 15 minutes run out.

Rate limit for `/auth/google`, `/auth/refresh`, `/auth/logout`, `/auth/login/*`, `POST /auth/qr` and `/invites/lookup`: `RATE_LIMIT_AUTH_PER_MINUTE` (default 20) per IP. Everything else: `RATE_LIMIT_API_PER_MINUTE` (default 300).

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
| `POST` | `/invites/lookup` | none | `{ token }` → `{ organizationName, logoUrl, email, role, expiresAt }` for the login page (which shows the company's logo and name). POST keeps the token out of URL logs. |

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
| `GET` | `/products?q=&category=&active=&sort=` | Catalog (any member). Each product has `inCatalog` and `catalog { status (pending / synced / error / removed / ""), error, retailerId, syncedAt }` (Phase 8C). |
| `POST` | `/products` | `{ name, sku?, category?, description?, unit?, hsnSac?, pricePaise?, gstRatePct?, moq?, stockQty?, images?, active?, inCatalog? }` — tax-exclusive price in paise; `inCatalog` shows it in the WhatsApp catalog (needs a price and an https photo in `images[0]`). Changing what Meta shows of an included product sets it back to `pending`. |
| `GET` | `/products/whatsapp-catalog` | Phase 8C, any member: `{ available (the plan has the catalog), catalogs [{ accountId, accountName, catalogId, name, status, lastSyncAt, lastSync { sent, removed, failed, error } }], products { included, synced, failed } }`. |
| `POST` | `/products/whatsapp-catalog/sync` | Owners and admins: syncs every connected catalog now (409 `NO_CATALOG`; 403 `PLAN_LIMIT` below Growth). |
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
| `GET` | `/orders?stage=&contactId=&leadId=&q=` | `q` searches the order and quotation numbers, the customer and the LR number. Every order has `paymentStatus` (unpaid / partly_paid / paid — paid also when moved to Payment Collected by hand), `amountPaidPaise`, `duePaise` (0 when cancelled or paid) and `payments[]` (Phase 8). |
| `GET` | `/orders/summary` | `{ counts { <stage>: n }, total }`. |
| `GET` | `/orders/dues?q=&minDays=` | Phase 8: orders with money still to come (not cancelled, not Payment Collected), oldest order date first, at most 500: `{ items [{ id, number, stage, orderDate, customer { name, company, phone }, totalPaise, amountPaidPaise, duePaise, paymentStatus, daysOutstanding, bucket (0-7 / 8-30 / 31-60 / 60+), openLink { id, shortUrl, status, sentAt } }], summary { count, duePaise, buckets { <bucket>: { count, duePaise } } }, truncated }`. |
| `POST` | `/orders` | `{ quotationId }` — from an accepted quotation, once (409 `NOT_ACCEPTED`, `ORDER_EXISTS`); copies its lines, totals and parties; number `<order prefix>/<financial year>/<0001>` (default SO). Accepts `Idempotency-Key`. The quotation can then not be un-accepted or deleted. |
| `GET/PATCH` | `/orders/:id` | PATCH `{ dispatch { transporter, lrNumber, vehicleNumber, expectedDeliveryDate }, notes }`. |
| `POST` | `/orders/:id/stage` | `{ stage, note?, cancelReason?, dispatch? }`. Stages: Received → Processing → Dispatched → Delivered → Payment Collected (any step, forwards or back), or Cancelled (reason required, 422 `CANCEL_REASON_REQUIRED`; not once paid, 409 `ORDER_PAID`; final, 409 `ORDER_CANCELLED`). Dispatched stamps `dispatch.dispatchedAt`, Delivered `deliveredAt`, Payment Collected `paidAt` and wins the lead (the contact becomes a customer). With "reduce stock on dispatch" the products' stock goes down once (never below 0) when the order reaches Dispatched or later, and comes back if it is cancelled or moved back. Each move goes to `history` and the lead's timeline. |
| `GET` | `/orders/:id/notify-options` | Needs `inbox` too. `{ blocked, windowOpen, text (a ready message for the stage), templates [with suggested values: name, order number, stage, transporter + LR] }`. |
| `POST` | `/orders/:id/payments` | Phase 8: money received outside the payment links. `{ amountPaise, method: cash / bank_transfer / upi / cheque / card / other, reference?, paidAt? }`. Same effects as a link payment: the first payment wins the lead (D40); paid in full, a Delivered order moves to Payment Collected. 409 `ORDER_CANCELLED`. |
| `DELETE` | `/orders/:id/payments/:paymentId` | Removes a payment entered by hand (409 `GATEWAY_PAYMENT` for a payment-link payment). A payment by hand that pays the order in full also cancels the order's unpaid links (a part-paid link cannot be cancelled at the gateway). |
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

**Triggers** (`trigger.type` and `params`): `lead.created` { sources[] } (manual leads, lead sources, first WhatsApp messages); `message.received` { keywords[] } (any word, capitals ignored); `lead.stage_changed` { toStages[], fromStages[] } (by a person, a quotation being sent, an order being paid or another workflow); `order.stage_changed` { toStages[] }; `payment.received` (a payment through a link, a payment entered by hand, or an order moved to Payment Collected; `amountPaise` is that payment); and four found by a scan every 10 minutes, each once per thing: `lead.no_reply` { hours 1–720, default 24 } (our message was the last one in the chat, up to 7 days back), `quotation.not_accepted` { days 1–90, default 3 } (still Sent or Viewed; once per revision), `task.overdue` (not done, due in the last 30 days; once per due date), `payment.overdue` { days 1–180, default 7 } (Phase 8: an order not cancelled or collected and not fully paid that many days after its order date, up to 90 days back; once per order and amount paid, so a part payment lets it come again). Empty lists mean "any".

**Conditions** (`{ field, op, value }`, all must hold): `source` in / notIn [sources]; `stage` in / notIn [stages]; `tag` has / hasNot "tag" (the customer's tags, capitals ignored); `owner` is / isNot memberId, none, any; `businessHours` open / closed (Settings → Lead rules).

**Steps** (`{ type, params }`, in order): `whatsapp.text` { text } (only inside the 24-hour window, else skipped); `whatsapp.template` { templateId, variables { header, body, buttons } } (each variable a CRM value from `variableValues` or `text:<words>`; a value the customer does not have — no company, a lead without a title — skips the step; a marketing template skips opted-out customers; the chat is opened if needed and goes to the lead's owner); `assign` { memberId } (lead, unowned customer and unassigned chats); `tag.add` / `tag.remove` { tag }; `stage.change` { stage, lostReason when Lost } (through the same rules as a person: probability, customer on Won, timeline); `task.create` { title, description?, dueInDays 0–365 (default 1), assignTo "owner" or memberId, priority }; `agent.notify` { to "owner" (the lead's owner, else the task's assignee, else owners and admins) \| "managers" \| memberId, message } (the bell); `wait` { amount, unit minutes/hours/days } (at most 90 days); `webhook.call` { url } (public https only, checked again on every call; no redirects; 10 s timeout); `sequence.enroll` { sequenceId } (the customer and their lead; skipped while they are already in it or the sequence is not Active; 400 `INVALID_SEQUENCE` on save for another organization's sequence); `payment.link` {} (Phase 8: the run's order — or a quotation's order — gets its open payment link, or a new one for what is due, sent as a text inside the 24-hour window or the payment-link template of Settings → Payments, else the step fails with 422 `NO_LINK_TEMPLATE`; paid and cancelled orders are skipped; also a sequence step). Texts, task titles and notifications may use `{{contact.name}}`, `{{contact.company}}`, `{{contact.city}}`, `{{contact.phone}}`, `{{lead.title}}`, `{{lead.stage}}`, `{{lead.source}}`, `{{owner.name}}`, `{{org.name}}`, `{{order.number}}`, `{{order.stage}}`, `{{order.total}}`, `{{order.paid}}`, `{{order.due}}`, `{{quotation.number}}`, `{{quotation.total}}`, `{{task.title}}`, `{{task.due}}`, `{{message.text}}`.

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
| `GET` | `/whatsapp/connect` | "Connect WhatsApp" (D60): `{ available (the platform's Meta app is set up), appId, configId, graphVersion (for Meta's popup; not secrets), connected, accounts, devTools }`. |
| `POST` | `/whatsapp/accounts/embedded-signup` | What Meta's Embedded Signup popup gave the page: `{ code (valid 30 s), wabaId, phoneNumberId?, mode: 'coexistence' (the WhatsApp Business app number, default) \| 'new' }` → 201 the account. The server exchanges the code for a business token (`GET /oauth/access_token`, server to server), reads the WABA's number (`GET /<waba>/phone_numbers`), subscribes the app (`POST /<waba>/subscribed_apps`), registers a new number with a PIN (`POST /<phone>/register`), and for an app number queues the contacts-then-history sync (`POST /<phone>/smb_app_data`, Meta allows it within 24 hours). Connecting this company's number again reconnects it. 409 `CONNECT_NOT_AVAILABLE`, 400 `WHATSAPP_CONNECT_FAILED` (e.g. an expired code), 409 `NUMBER_IN_USE` (another company), plan limit. |
| `POST` | `/whatsapp/accounts/:id/sync` | Asks Meta again for the contacts and chats of a WhatsApp Business app number → the account with `sync.status: 'pending'`. |
| `GET` | `/whatsapp/accounts` | Connected numbers: `{ id, name, provider (meta/mock), connectionType (manual/embedded/coexistence), connectedAt, sync ({ status pending/importing/done/declined/failed, contacts, chats, messages, phase, progress, error, finishedAt } or null), phoneNumberId, wabaId, displayPhone, verifiedName, qualityRating, messagingLimit, status (pending/connected/error/disconnected), statusMessage, isDefault, lastWebhookAt, webhookPath, webhookUrl, verifyToken (manual numbers only), accessToken: { configured, last4 }, appSecretConfigured }`. The access token and app secret are never returned. |
| `POST` | `/whatsapp/accounts` | Advanced: `{ name?, provider?, phoneNumberId, wabaId?, accessToken, appSecret }` (a number on the company's own Meta app) or `{ provider: "mock", name? }` (developer test tools: `DEV_TOOLS=on`, never in production). The CRM asks Meta about the number (`GET /<version>/<phoneNumberId>`) and saves the result as `status`. A number connected anywhere else is 409 `NUMBER_IN_USE`. |
| `PATCH` | `/whatsapp/accounts/:id` | `{ name?, wabaId?, accessToken?, appSecret?, isDefault: true? }`; a new token is checked again. |
| `POST` | `/whatsapp/accounts/:id/test` | Asks Meta again and updates `status`. |
| `DELETE` | `/whatsapp/accounts/:id` | Soft delete ("Disconnect"); chats stay, the number can be connected again. A "Connect WhatsApp" number also unsubscribes the platform's app from its WABA (best effort). |
| `PUT` | `/whatsapp/accounts/:id/catalog` | Phase 8C: `{ catalogId, catalogVisible?, cartEnabled? }` — Meta is asked about the catalog with the number's token (`GET /<catalog>?fields=id,name,product_count`; 400 `CATALOG_REFUSED` when it cannot be opened); with the two flags also `POST /<phone number id>/whatsapp_commerce_settings` (shop button, cart). Then a `catalog.sync` job runs at once and daily. Numbers carry `catalog { catalogId, name, productCount, status, statusMessage, catalogVisible, cartEnabled, lastSyncAt, lastSync }` (or null). 403 `PLAN_LIMIT` below Growth. |
| `DELETE` | `/whatsapp/accounts/:id/catalog` | Stops syncing and sending products (Meta keeps the catalog). |
| `GET` | `/whatsapp/click-to-chat?accountId=&text=` | `{ accountId, phone, link, qrDataUrl }`: the `https://wa.me/<number>?text=<pre-filled message>` link of a number (default number if none given) and its QR code as an SVG data URL. 400 `NO_DISPLAY_PHONE` until the number was checked with Meta. |
| `GET` | `/whatsapp/click-to-chat/qr.png?accountId=&text=` | The same QR code as an 800 px PNG download (`whatsapp-qr.png`). |

### Webhooks (public, called by Meta)

**The platform's app (D60):** `/api/v1/webhooks/meta` serves every number connected with "Connect WhatsApp". `GET`: handshake with `META_WEBHOOK_VERIFY_TOKEN` (else 403). `POST`: `X-Hub-Signature-256` = HMAC-SHA256 of the raw body (up to 16 MB) with `META_APP_SECRET` (else 401; 404 while the app is not set up). Each change goes to the company of the number in `metadata.phone_number_id` (or of the WABA `entry.id` for `account_update`); unknown numbers are skipped. Fields: `messages` (as below), `message_template_status_update`, `history` (chats of the last 6 months in chunks with `phase` 0–2 and `progress`; imported with their real times, chats of the last week open, older ones closed; error 2593109 = history sharing turned off → `sync.status: 'declined'`), `smb_message_echoes` (sent from the WhatsApp Business app: stored as outgoing with `origin: 'phone'`), `smb_app_state_sync` (contacts), `account_update` (`PARTNER_REMOVED` → `status: 'disconnected'`). History, echoes and contacts run no automation, bot, auto-reply, lead creation or notification. Messages carry `origin` (`history`, `phone` or null). Sync progress goes to owners and admins over Socket.IO as `whatsapp:sync` `{ accountId, sync }`.

**A number on the company's own Meta app** has its own URL `/api/v1/webhooks/whatsapp/<webhookKey>` (not rate limited with the API; own limit `RATE_LIMIT_WEBHOOK_PER_MINUTE`).

| Method | Purpose |
| --- | --- |
| `GET` | Handshake: `?hub.mode=subscribe&hub.verify_token=<verify token>&hub.challenge=<n>` → 200 with the challenge, else 403. |
| `POST` | Messages, statuses and template status changes (fields `messages` and `message_template_status_update`). `X-Hub-Signature-256` must be `sha256=` + HMAC-SHA256 of the raw body with the app secret (else 401). Items for another connected number of the same organization (one Meta app, one callback URL) go to that number; unknown numbers are skipped. Each message and status is stored as an `InboundEvent` (Meta's retries are ignored), the answer is 200, then: the contact is found by phone or created (source WhatsApp; a new number also gets a WhatsApp lead), the conversation is opened, the message stored, the 24-hour window moved; statuses move sent → delivered → read (never back; failed keeps Meta's error); photos, documents, audio and video are copied into private storage (see "Files in chats"); a template status change updates the template (reason kept). Events that could not be processed are retried at start-up and every 5 minutes. |

### Products and carts from the WhatsApp catalog (Phase 8C)

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/conversations/:id/catalog` | `{ blocked, windowOpen, products [{ id, name, category, unit, pricePaise, gstRatePct, priceWithGstPaise, image, retailerId }] }` — synced products of the chat's number. |
| `POST` | `/conversations/:id/products` | `{ productIds (1–30), header?, body? }` inside the 24-hour window (422 `WINDOW_CLOSED`): one product → Cloud API `interactive.type: product`; several → `product_list` with the heading (default "<business> products") and sections by category (at most 10). The message keeps `interactive { kind: product / product_list, products [{ productId, retailerId, name }] }`. 400 `NOT_IN_CATALOG` for products that are not synced. |

A cart the customer sends back arrives as a message of type `order` (`order { catalogId, text, items [{ retailerId, quantity, itemPricePaise, currency }], orderId }`). The `catalog.order` job makes an order once per message: items matched to products by `catalog.retailerId` (or the product id) and priced as usual (GST on the tax-exclusive price, D43); an unknown item goes in at the cart's price without GST, with a warning (`order.catalogOrder.warnings`, also a price that changed by more than ₹1); `source: "catalog"`, stage Received, the customer's note in `notes`, the open lead's timeline; the customer gets a thank-you (`automation.kind: "catalog-order"`), the order's owner (else owners and admins) a bell note, and the chat shows "Open the order".

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
| `POST` | `/conversations/:id/private` | Owners only (D61): `{ note? }` → the chat's number becomes private (see Private numbers). Conversations carry `private: true` for such chats; only owners ever receive them. |
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
| `POST` | `/dev/simulate/whatsapp-inbound` | Owners/admins. `{ from, name?, type? (text/image/document/audio/interactive/order), text, replyId? (interactive), items? (order: [{ retailerId, quantity, price in rupees }]), catalogId?, accountId? }` → processes a made-up incoming message exactly like a webhook (photos, documents, voice notes and button taps only on test numbers; media get a sample file and `text` is the caption; `interactive` is a tapped reply button with id `replyId` and title `text`); returns `{ conversationId, messageId, contactId }`. |

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

## Payments (Phase 8)

### Gateways and settings (Settings → Payments, owners and admins)

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/payments/connections` | The organization's gateways: `{ id, provider (razorpay / cashfree / mock), providerName, name, mode (test / live), keyId, keySecret { configured, last4 }, webhookSecretConfigured, webhookUrl, status, statusMessage, isDefault, lastCheckedAt, lastWebhookAt }`. Secrets are never returned. |
| `POST` | `/payments/connections` | Razorpay `{ provider, keyId, keySecret, webhookSecret }` (test or live from the key id); Cashfree `{ provider, keyId (app id), keySecret, mode }`; the test gateway `{ provider: "mock" }` (not in production). The keys are checked with the gateway first: 400 `PAYMENT_KEYS_REFUSED` saves nothing; an unreachable gateway saves the connection with `status: "error"`. One per gateway (409 `GATEWAY_EXISTS`); the first is the default. |
| `PATCH` | `/payments/connections/:id` | `{ name, keyId, keySecret, webhookSecret, mode, isDefault: true }`; new keys are checked again. |
| `POST` | `/payments/connections/:id/test` | Checks the keys again. |
| `DELETE` | `/payments/connections/:id` | Links made through it stay, but their webhooks (404) and status checks stop. |
| `GET/PUT` | `/payments/settings` | `{ expiryDays (1–180, default 7), sendReceipt (default true), linkTemplateId, receiptTemplateId }` — the approved templates used when the customer's 24-hour window is closed (400 `TEMPLATE_NOT_APPROVED`, or `TEMPLATE_NOT_SENDABLE` for one that needs a PDF heading). |

### Payment links (same permissions as orders)

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/payment-links` | One of `{ orderId }` (default amount: what is still due; 409 `NOTHING_DUE`, `ORDER_CANCELLED`), `{ quotationId }` (its total; once it has an order, the order is used; 409 `REVISE_FIRST` when rejected or expired) or `{ contactId, amountPaise }` (an advance or any amount); plus `amountPaise?` (≥ ₹1, not more than due — 400 `MORE_THAN_DUE`), `description?`, `acceptPartial?`, `minPartialPaise?`, `expiresInDays?`, `connectionId?` (else the default gateway; 409 `NO_PAYMENT_GATEWAY`). One open link per order or quotation (409 `OPEN_LINK_EXISTS`; an order's check also counts a link still open for its quotation). Needs a plan with payment links (403 `PLAN_LIMIT`). The gateway does not send SMS or email; the CRM sends the link on WhatsApp (8B). Accepts `Idempotency-Key`. |
| `GET` | `/payment-links?status=&orderId=&quotationId=&contactId=` | `{ id, provider, mode, referenceId (ycrm_…), providerLinkId, shortUrl, purpose (order / quotation / amount), orderId, quotationId, contactId, leadId, documentNumber, description, customerName, amountPaise, amountPaidPaise, acceptPartial, minPartialPaise, status (created / partially_paid / paid / expired / cancelled), expiresAt, paidAt, payments[] { providerPaymentId, amountPaise, method, paidAt }, receipts[] { providerPaymentId, status sent / skipped / failed, reason, messageId }, lastSyncedAt, lastSyncError }`. Agents see the links of their own customers. |
| `GET` | `/payment-links/options?orderId=\|quotationId=\|contactId=` | What the "Payment link" dialog needs: `{ blocked (why no link can be made: no gateway, plan, paid already …), gateways [{ id, provider, name, mode, isDefault, status }], expiryDays, purpose, documentNumber, customerName, amountPaise (suggested), maxPaise, openLink, links (the last 10 of the order / quotation / customer) }`. |
| `GET` | `/payment-links/:id` | One link. |
| `GET` | `/payment-links/:id/send-options` | Needs `inbox` too. `{ blocked, windowOpen, text (a ready message with the amount, the document, the link and its last day), templates [with suggested values: name, amount, document number, link; a URL button gets the end of the link after its fixed start], preferredTemplateId (Settings → Payments), link }`. |
| `POST` | `/payment-links/:id/send` | Needs `inbox` too. `{ mode: "text", text }` (window open, else 422 `WINDOW_CLOSED`) or `{ mode: "template", templateId, variables }`; opens the chat if there is none; stamps `sentAt` and the lead's timeline. 409 `LINK_CLOSED`, `NO_PHONE`, `CHAT_ASSIGNED`. Accepts `Idempotency-Key`. |
| `POST` | `/payment-links/:id/refresh` | Asks the gateway now (the same as the 10-minute check). |
| `POST` | `/payment-links/:id/cancel` | Cancels it at the gateway (409 `LINK_CLOSED`, `PARTLY_PAID`). |

What a payment does (from a webhook or a status check, once per gateway payment id): it is added to the link; a quotation's link accepts the quotation and makes its order; the payment goes on the order (`payments[]`, source `link`); the lead is won (D40); paid in full, a Delivered order moves to Payment Collected; the customer gets a receipt (D41: a text inside the 24-hour window, else the receipt template, else none and the bell says why; `message.automation.kind: "receipt"`); the link's maker and the order's owner get a bell note; `payment.received` starts workflows.

### Webhooks (public, called by the gateways)

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/webhooks/payments/razorpay/<key>` | Razorpay: `X-Razorpay-Signature` = hex HMAC-SHA256 of the raw body with the webhook secret (401 otherwise); `payment_link.paid`, `.partially_paid`, `.expired`, `.cancelled` are stored once per `X-Razorpay-Event-Id` and handled by the `payment.webhook` job; other events get 200 and are ignored. |
| `POST` | `/webhooks/payments/cashfree/<key>` | Cashfree: `x-webhook-signature` = base64 HMAC-SHA256 of `x-webhook-timestamp` + raw body with the secret key; `PAYMENT_LINK_EVENT`. |
| `GET/POST` | `/webhooks/payments-test/<mock link id>` | Development only (404 in production): the test gateway's payment page; the form pays the link (or part of it) as a gateway would report it. |

## Reports (Phase 9)

`?from=YYYY-MM-DD&to=YYYY-MM-DD` are calendar days in India, both included (default: the last 30 days; at most three years; 400 `INVALID_RANGE` / `RANGE_TOO_LONG`). Owners, admins and members with `reports:view_all` (or `leads:view_all` for lead figures) see the whole company (`scope: "company"`); everyone else sees their own leads, quotations, orders, chats and work (`scope: "own"`, D45). Amounts are paise; durations seconds. Counted on request (D47).

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/reports/overview` | Module `reports`. `{ range, scope, leads { created, won, lost, winRatePct }, quotations { sent, accepted }, orders { count, valuePaise }, payments { collectedPaise, count }, customers { new }, pipeline { open, valuePaise, weightedPaise, byStage [{ stage, count, valuePaise }] } (now), dues { orders, duePaise } (now), whatsapp { newChats, inboundMessages, replies, firstResponseMedianSeconds, responseMedianSeconds, responseAverageSeconds }, tickets { created, resolved } }`. A lead's value is its expected value, else its latest quotation's total; won/lost count by the day the stage changed. |
| `GET` | `/reports/trend` | `{ range { unit: day / week (Monday) / month }, items [{ bucket, leads, won, orders, orderValuePaise, collectedPaise }] }` — every bucket of the range, also empty ones (days up to 62 days, weeks up to 210, then months). |
| `GET` | `/reports/agents` | Agent performance: `{ items [{ memberId, name, role, active, chatsHandled, messagesSent, replies, firstResponseMedianSeconds, responseMedianSeconds, responseAverageSeconds, leadsByStage (now), leadsCreated, won, lost, winRatePct, quotationsSent, quotationsAccepted, orders, orderValuePaise, collectedPaise, tasksDone, ticketsResolved, chatsResolved, resolutionRatePct, resolutionMedianSeconds }], team { …, chatsResolved, resolutionMedianSeconds }, truncated }`. Resolved (D61): chats closed in the range, counted for the chat's assignee (else whoever closed it), timed from the (re)opening to the close; the rate is resolved / handled, at most 100. Response time (D46): from a customer's first unanswered message to a teammate's reply in the range (bot, auto-reply and broadcast messages do not stop the clock; a week before the range is read to know who was waiting); "first response" only for chats that began then. Every active member is listed. |
| `GET` | `/reports/me` | Any member (D61, "My performance"): `{ range, me }` — their own row of the agent report, whatever their permissions. |
| `GET` | `/reports/team-live` | Owners and admins (D61, "Team live"): `{ at, items [{ memberId, name, role, online (a request in the last 5 minutes), lastSeenAt, openChats, waitingChats (the customer wrote last), oldestWaitingSince, repliesToday, resolvedToday, firstResponseMedianSeconds }], queue { openChats, waitingChats, oldestWaitingSince } (not taken yet), today { replies, resolved, waiting, online, firstResponseMedianSeconds } }`. |
| `GET` | `/reports/sources` | `{ items [{ source, enquiries, repeatEnquiries, rejected (from the intake log), leads, byStage, funnel { created, contacted, quoted, won } (how far the range's leads have got), conversionPct }], totals }`. |
| `GET` | `/reports/quotations` | Quotations sent in the range: `{ totals { sent, viewed, accepted, rejected, expired, open, winRatePct, viewedPct, sentValuePaise, acceptedValuePaise, averageDaysToAccept }, byOwner [], rejectionReasons [{ reason, count }] }`. |
| `GET` | `/reports/broadcasts` | Owners and admins (others get `items: []`): broadcasts started in the range with recipients, sent, delivered, read, replied, failed, skipped and `deliveredPct` (of sent), `readPct` and `repliedPct` (of delivered), `failedPct`; totals. |
| `GET` | `/reports/payments` | `{ collected { amountPaise, count }, byWay (payment link · gateway / by hand · method), byMethod, trend [{ bucket, amountPaise, count }], links { made, paid, averageHoursToPay }, ordersPaidInFull, averageDaysToCollect, dues { count, duePaise, buckets { 0-7, 8-30, 31-60, 60+ } } (now) }`. |
| `GET` | `/reports/export?type=overview\|trend\|agents\|sources\|quotations\|broadcasts\|payments` | The report as a CSV download (UTF-8 with BOM for Excel; amounts in rupees, times in minutes). A cell that starts with `=`, `+`, `-`, `@` gets a leading apostrophe, so a spreadsheet never runs it. |
| `GET` | `/reports/dashboard` | Module `dashboard`: `{ today, scope, leads { today, month, wonMonth }, chats { waitingForReply, unassigned, longestWaitMinutes }, pipeline { open, valuePaise }, quotations { waitingThreeDays }, payments { collectedMonthPaise, dueOrders, duePaise }, tasks { dueToday, overdue } }`. |
| `GET` | `/reports/insights` | Module `insights`: `{ pipeline { open, valuePaise, weightedPaise, byStage }, atRisk { count, valuePaise, items } (no activity for 14 days, or a quotation waiting 7), negotiation, unassignedLeads, priority (value × stage probability, with a next step), slowChats (waiting 2 hours or more), dues { over30Paise }, last90Days { won, lost, winRatePct, responseMedianSeconds, collectedPaise } }`. |

## Plan and billing (Phase 10)

The plans are data (`constants/plans.js`); `planService` checks them before something counted is added. **403 `PLAN_LIMIT`**: the plan does not allow more (users = active members + pending invites, WhatsApp numbers, contacts added by hand or imported — never those from WhatsApp messages or lead sources, message templates, quotations made this month, broadcasts started this month keep their 409 `QUOTA_REACHED`) or lacks a feature (payment links, the WhatsApp catalog, workflows, the API). **403 `SUBSCRIPTION_INACTIVE`**: the trial ended without a plan, or the plan is halted or ended (D49); reading, replying, receiving messages and leads and recording payments still work. Both carry `errors[0] { field, message, limit?, used? }`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/billing/plans` | Every member: `{ plans [{ key, name, pricePaise, gstPaise, totalPaise, limits { users, whatsappNumbers, contacts, broadcastsPerMonth, quotesPerMonth, templates } (null = no limit), features { paymentLinks, conversionsApi, catalog, advancedAutomation, api } }], limits [{ metric, label, monthly }], features [{ feature, label }], gstPct, trialDays }`. |
| `GET` | `/billing/subscription` | Every member (the banner): `{ plan, subscription { status trialing/active/past_due/halted/cancelled/expired/comped, locked, trialEndsAt, daysLeft, wasTrial, currentPeriodEnd, cancelAtPeriodEnd, pendingPlan, provider, checkoutUrl (a started, unpaid checkout), firstChargeAt (chosen during the trial) }, usage [{ metric, label, used, limit, left, monthly }] (owners and admins), billing { enabled, provider, test, contactEmail } }`. A trial past its end and a cancelled plan past its paid month read `expired`. |
| `POST` | `/billing/checkout` | Owners and admins. `{ plan }` → `{ checkoutUrl, startsAt }` (pay on Razorpay's page; during the trial the first charge is at its end) or, with a paid plan, `{ changed, when: now (upgrade) / cycle_end (downgrade), plan }`. 409 `BILLING_OFF` (with whom to write to), `SAME_PLAN`, `PLAN_CHANGE_REFUSED` (UPI / e-mandate subscriptions). |
| `POST` | `/billing/subscription/cancel` | Owners and admins: at the end of the paid month (at once if nothing was charged yet). 409 `NOT_SUBSCRIBED`. Returns the subscription. |
| `POST` | `/billing/subscription/refresh` | Owners and admins: "Check now" — reads the subscription and its paid invoices from Razorpay (payments whose webhook did not arrive get their invoice). |
| `GET` | `/billing/invoices` | Owners and admins: the GST invoices `[{ id, number, issuedAt, planName, periodStart, periodEnd, taxablePaise, gstPaise, totalPaise }]`. |
| `GET` | `/billing/invoices/:id/pdf` | Owners and admins: the tax invoice PDF. |

Webhooks (public): `POST /webhooks/billing/razorpay` (the platform's Razorpay account; `X-Razorpay-Signature` = hex HMAC-SHA256 of the raw body with `RAZORPAY_BILLING_WEBHOOK_SECRET`, repeats ignored by `X-Razorpay-Event-Id`; 401 bad signature, 404 when Razorpay billing is not configured). Development only: `GET/POST /webhooks/billing-test/:subscriptionId` — the test gateway's checkout page (`action` = pay / charge / fail).

## Integrations (Phase 10C)

Owners and admins; the API keys and webhooks need a plan with the API (Growth and up, 403 `PLAN_LIMIT`), the Conversions API needs Pro and up. Guide and the public API reference: [INTEGRATIONS.md](INTEGRATIONS.md).

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api-keys` | `{ items [{ id, name, preview (ycrm_<prefix>_…), scopes, createdAt, createdBy, lastUsedAt, revokedAt }], scopes [{ scope, label }] }`. |
| `POST` | `/api-keys` | `{ name, scopes[] }` → 201 with `key` (shown this once; only its SHA-256 is kept). At most 20 active keys (409 `TOO_MANY_KEYS`). |
| `DELETE` | `/api-keys/:id` | Revoke. |
| `GET` | `/outbound-webhooks` | `{ items [{ id, url, events, description, active, disabledReason, failuresInARow, lastDeliveryAt, lastStatus, lastResponseCode }], events [{ event, label }] }`. |
| `POST` | `/outbound-webhooks` | `{ url (public https), events[], description? }` → 201 with `secret` (whsec_…, shown once). 400 `WEBHOOK_URL` for a private / local / non-https address. At most 20. |
| `PATCH` | `/outbound-webhooks/:id` | `{ url?, events?, description?, active? }` (switching on clears the failure count; switching off cancels pending deliveries). |
| `DELETE` | `/outbound-webhooks/:id` | Remove. |
| `POST` | `/outbound-webhooks/:id/test` | A `ping` now → the delivery with its result. |
| `POST` | `/outbound-webhooks/:id/rotate-secret` | A new secret (shown once). |
| `GET` | `/outbound-webhooks/:id/deliveries?status=&page=&limit=` | The delivery log (30 days): event, status pending/delivered/failed/cancelled, attempts, nextAttemptAt, responseCode, responseBody (500 characters), error, durationMs, payload. |
| `POST` | `/outbound-webhooks/deliveries/:id/retry` | Send a failed or cancelled one again now. |
| `GET` | `/meta-conversions` | `{ available, connected, datasetId, datasetName, accessToken { last4 }, testEventCode, enabled, allSources, stages, status, stats { sent, skipped, failed, lastSentAt, lastError }, stagesAvailable }`. |
| `PUT` | `/meta-conversions` | `{ datasetId, accessToken (first time / to change), testEventCode?, enabled?, allSources?, stages? }` — a new dataset or token is checked with Meta (`GET /<dataset>?fields=id,name`, 400 `META_ERROR`). |
| `DELETE` | `/meta-conversions` | Remove. |
| `POST` | `/meta-conversions/test` | A sample event with the test event code (400 without one). |

**Public API** (`/api/public/v1`, API key, scopes, per-key rate limit): `GET /me`, `GET/POST /contacts`, `GET/PATCH /contacts/:id`, `GET/POST /leads`, `GET /leads/:id`, `POST /leads/:id/stage`, `GET /quotations`, `GET /quotations/:id`, `GET /orders`, `GET /orders/:id`, `GET /products`, `POST /messages` — see [INTEGRATIONS.md](INTEGRATIONS.md). Errors: 401 `API_KEY_INVALID`, 403 `SCOPE_MISSING` / `PLAN_LIMIT` / `SUBSCRIPTION_INACTIVE`, 429 `RATE_LIMITED`.

**Outbound webhook calls**: `POST` JSON `{ id: evt_…, type, createdAt, data }` with `X-CRM-Event`, `X-CRM-Event-Id`, `X-CRM-Delivery`, `X-CRM-Signature: sha256=<HMAC-SHA256 of the raw body with the webhook's secret>`; 2xx within 10 s, else retried after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h; switched off after 25 failed deliveries in a row.

## AI assistant (Phase 10D)

Guide: [AI_ASSISTANT.md](AI_ASSISTANT.md). 409 `AI_UNAVAILABLE` (no platform key, switched off, plan not active, monthly budget used up — the message says which), 502 `AI_FAILED` (the Claude API failed after the SDK's retries; a plain message), 422 `AI_NO_ANSWER` (refused / no suggestion).

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/ai/status` | Every member: `{ available, autoReply }` (does the inbox show "Suggest a reply"). |
| `GET` | `/ai/settings` | Owners and admins: `{ configured, enabled, autoReply, instructions, models { suggest, autoReply }, month { calls, suggested, sent, handoffs, inputTokens, outputTokens, cacheReadTokens, costUsd, budgetUsd } }`. |
| `PUT` | `/ai/settings` | `{ enabled?, autoReply?, instructions? (≤1500) }` — autoReply on also switches enabled on; enabled off switches autoReply off; 403 `SUBSCRIPTION_INACTIVE` to switch on while the plan is not active. |
| `POST` | `/ai/test` | `{ message }` → `{ reply, handoff, confidence, reason }` — what it would answer a customer; nothing is sent. |
| `POST` | `/conversations/:id/ai/suggest` | Inbox edit permission and a chat the member may see: `{ suggestions [1–3 strings], note }`. |

## Mobile app, web push and phone sign-in (Phase 10E)

The pages are an installable app (`crm/frontend/manifest.webmanifest`, service worker `sw.js`: offline page, push notifications; the API is never cached).

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/push/key` | The VAPID public key (base64url) to subscribe with. |
| `GET` | `/push/devices` | `{ devices }` — this member's subscribed browsers / apps. |
| `POST` | `/push/subscriptions` | The browser's `PushSubscription.toJSON()` (`{ endpoint (https), keys { p256dh, auth } }`) → 201 `{ id, devices }`; at most 10 per member. |
| `DELETE` | `/push/subscriptions` | `{ endpoint }` — this member's device only. |
| `POST` | `/push/test` | A test notification to this member's devices → `{ sent, removed }`; 409 `NO_DEVICES`. |
| `GET` | `/auth/phone` | Signed in: `{ phone, verifiedAt, available, twoStep, twoStepMode (optional/required/off) }`. |
| `POST` | `/auth/phone/request` | `{ phone }` → a code to verify (or change) one's own number; 409 `PHONE_IN_USE`. |
| `POST` | `/auth/phone/verify` | `{ phone, code }` → the number is verified for logging in. |
| `DELETE` | `/auth/phone` | Removes it, and switches 2-step verification off. |
| `PUT` | `/auth/two-step` | `{ enabled }` — 2-step verification for oneself (D60): on a new browser, a WhatsApp code after Google. Needs a verified number (400 `PHONE_REQUIRED`); 409 `TWO_STEP_FIXED` when `LOGIN_WHATSAPP_CODE` is required or off. Audit `auth.two_step_on` / `auth.two_step_off`. |

The 2026-10-08 login (D58) replaced the Phase 10E `/auth/otp/available`, `/auth/otp/request` and `/auth/otp/verify` (a code alone no longer signs in): see `/auth/login/*` and `/auth/qr*` under Auth.

Every bell note (`notificationService.notify`) is also sent as web push to the member's devices: `{ title, body, url, tag }`, encrypted (RFC 8291 aes128gcm) and signed (RFC 8292 VAPID).

## Audit log, export and deleting the company (Phase 10F)

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/audit-logs?action=&entityType=&entityId=&actorUserId=&from=&to=&page=&limit=` | Owners and admins: `[{ id, at, action, entityType, entityId, actor { id, name, email } \| null, changes, ip }]` newest first, paginated; `action` matches the beginning (`contact.` = every contact action); `from`/`to` are days in India. |
| `GET` | `/audit-logs/meta` | `{ areas, actions, people [{ userId, name, email }] }` for the filters. |
| `GET` | `/exports/crm` | (Phase 2, extended) version 2: every section of the CRM — WhatsApp numbers, chats and messages, templates, lead sources and intakes, rules, the FAQ bot, sequences and runs, segments and broadcasts, payment gateways, plan invoices, API keys, webhooks, the Conversions API, AI usage, the audit log — without secrets (fields ending in Enc or Hash, hash, webhookKey, encrypted…, storage paths). |
| `GET` | `/organization/deletion` | Every member: `null` or `{ requestedAt, scheduledFor }` (also in `GET /billing/subscription` as `deletion`, for the banner). |
| `DELETE` | `/organization` | Owners: `{ confirmName }` (the company name, any case) → `{ requestedAt, scheduledFor }` (ORG_DELETION_GRACE_DAYS, 7). 400 wrong name, 409 `DELETION_SCHEDULED`. Owners and admins get a bell note. |
| `POST` | `/organization/deletion/cancel` | Owners: keep the company. 409 `NOT_SCHEDULED`. |

After the date a job (`organization.purge`, every 6 hours) removes every record with the organization's id, its files and logo, and stops its paid plan; the platform's GST invoices and users stay.

## Idempotency

`POST` endpoints that accept `Idempotency-Key` (8–128 characters) return the stored response for a repeated key with the same body (header `Idempotent-Replayed: true`), `422 IDEMPOTENCY_KEY_REUSED` for a different body, and `409 IDEMPOTENCY_IN_PROGRESS` while the first request is still running. Records expire after 24 hours.

## Private numbers (D61, owners only)

Personal chats (family, friends) that come in on the company's WhatsApp Business number. Making a number private marks its contact, leads, chats and messages `private`: only owners see them (lists, single reads — 404 for everyone else —, inbox counts, the owners' Socket.IO room); the public API, segments and broadcasts, reports and the "no reply" automation leave them out; new messages from the number (live, history, phone echoes) stay private and start no automation, bot, auto-reply, lead, catalog order or notification. Nothing is deleted. The audit log keeps the number masked (`privacy.number_private`, `privacy.number_visible`).

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/privacy/numbers` | `[{ id, phone, name, note, chats, addedAt }]`. |
| `POST` | `/privacy/numbers` | `{ phone, note? }` → 201 the entry (also for a number that has not written yet). |
| `DELETE` | `/privacy/numbers/:id` | Shown to the team again: `{ removed: true }`; new messages run automations again. |

Open Inbox pages get `inbox:refresh` over Socket.IO when a number changes. The evening team summary (7 pm India time, owners, bell + push, `source: 'team-summary'`, link `team-live.html`) is the job `reports.team-summary`, every 15 minutes, once a day per company.

## Planned

Phase 2 ends with the final checks (checkpoint G); then WhatsApp, lead sources, GST quotations, orders, broadcasts and payments. See [BIZNUMA_ROADMAP.md](BIZNUMA_ROADMAP.md) section 6 for the full endpoint plan.
