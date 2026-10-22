# Phase 4: Excel, Power BI, Outlook and Teams (spec)

Status: **approved with its defaults by the user's go-ahead of 2026-10-21** (questions and defaults are pre-approved up to Phase 10). The user said to start Phase 4 the same day. This is Phase 4, "Microsoft Ecosystem Integration" (inspired by Dynamics 365), of `docs/CRM_10_FEATURE_IMPLEMENTATION_PROMPT.md`. **4A was built the same day (D82);** what was built and its results are in sections 10 and 11. It is built in two parts:
- **4A** needs no Microsoft account: Excel files in and out, and a live data feed for Excel and Power BI.
- **4B** is Microsoft 365: Outlook calendar, Teams meeting links and Teams channel notes. It works with a mock until the platform owner registers a Microsoft app.

## 1. Goal

For an Indian SMB, "Microsoft" mostly means three things:

1. **Excel.** The accountant's sheet, the dealer list, the monthly MIS. Today the CRM refuses an .xlsx import ("save it as CSV first") and lists cannot be downloaded at all.
2. **Power BI / Excel dashboards** for the owner, refreshed without anyone copying data.
3. **Outlook and Teams** in companies on Microsoft 365. Meetings should show in Outlook with a Teams link, and the team should hear about a won deal in their Teams channel.

## 2. What exists today (from the code)

- **Import:**
  - Customers come in from CSV only (`contactImportService`), with column mapping, a dry run, merging and a report.
  - `.xlsx/.xls/.ods` files are refused with "Excel files are not read yet".
  - Uploads are at most 5 MB.
- **Export:**
  - Reports → each tab has "Export CSV" (`GET /reports/export`).
  - Settings → Data downloads the whole company as one JSON file (owners).
  - **The Contacts and Leads lists cannot be downloaded.**
- **Public API (Phase 10C, 1F):**
  - Paged JSON lists of contacts, leads, quotations, orders and products, with scoped keys and 120 calls a minute.
  - Nested and in paise, so it is awkward for Excel and Power BI.
- **Google:** Gmail is connected per member (read-only), with the OAuth state checked once and tokens encrypted (`secretBox`). There is no Microsoft code.
- **Calendar:** `CalendarEvent` (date, times, assignee, related record). Nothing is synced anywhere, and there is no meeting link.
- **Outbound webhooks (1F)** send signed JSON to a company's own systems. There is nothing in Teams' format.
- **No libraries** for Excel or zip files, but Node's own zlib can read and write the zip format that .xlsx files are made of.

## 3. Zoho CRM benchmark (official pages, checked 2026-10-21)

Sources:
- [Zoho CRM – Import data into a CRM module](https://help.zoho.com/portal/en/kb/crm/data-administration/import-data/articles/import-data-into-a-crm-module)
- [Zoho CRM – FAQs: Import](https://help.zoho.com/portal/en/kb/crm/faqs/data-administration/import/articles/faqs-import)
- [Zoho CRM – Export CRM Data](https://help.zoho.com/portal/en/kb/crm/data-administration/export-data/articles/export-crm-data)
- [Zoho CRM – FAQs: Exporting Data](https://help.zoho.com/portal/en/kb/crm/faqs/data-administration/export/articles/faqs-exporting-data-from-zoho-crm)
- [Zoho CRM – Synchronizing Meetings, Contacts and Tasks with Office 365](https://help.zoho.com/portal/en/kb/crm/integrations/microsoft/synchronize-with-office-365/articles/sync-meetings-contacts-tasks-with-office365)
- [Zoho CRM – Microsoft Teams Integration](https://www.zoho.com/crm/help/microsoft-teams-integration.html)
- [Zoho Creator Connector for Microsoft Power BI](https://www.zoho.com/creator/newhelp/setup/zoho-creator-connector-for-microsoftpowerbi.html) (Creator, not CRM)

What Zoho does well:
- **Import** accepts CSV, XLS, XLSX and VCF (5,000 records a batch for Excel files; more only as CSV).
- **Export** of a module as CSV (up to 200,000 records) or XLSX (up to 50,000). The download comes as a zip, and the link stays valid for 7 days.
- **Office 365 sync** of meetings, contacts and tasks. Only events the user owns sync, and at most 5,000 events in the first sync.
- **A Zoho CRM app in Teams:** dashboards as tabs, and sharing records in chats.

Where Zoho is limited:
- **No first-party Power BI connector for Zoho CRM** (UNVERIFIED that none exists; Zoho documents one for Zoho Creator only). The usual route is Zoho Analytics, a separate product, or a paid marketplace app.
- **Exports are by hand:** Zoho's FAQ says automated exports need Zoho Flow or the API.
- **Excel imports above 5,000 records** must be converted to CSV.
- **Two-way calendar sync** uses a separate calendar in Microsoft, according to a community post (UNVERIFIED in the official help).

Where YELLOW CRM Phase 4 will be better (each point can be checked):
- **A live feed for Excel and Power BI** on every plan with the API:
  - one URL and one header per table (contacts, leads, quotations, orders, products);
  - flat rows in rupees;
  - refreshed by Excel or Power BI on their own schedule, with no second product.
- **Excel imports** use the same mapping, merging and dry run as CSV, up to the same 10,000 rows.
- **One-click "Download Excel"** on Contacts, Leads and every report tab, honouring the filters on screen, with phone masking.
- **A Teams meeting link** on a CRM meeting in one click, and Outlook shows the meeting.
- **Teams channel notes** for won leads and other business events, with no app to install and no Microsoft login: a Teams "Workflows" webhook URL is enough.

Where it will **not** be better yet:
- **Calendar sync is one way (CRM → Outlook).** Outlook changes do not come back.
- **No Outlook mail or Outlook contacts sync,** and no Teams app with tabs.
- **No OneDrive or SharePoint documents.**
- **No ERP finance or inventory sync.**
- **The Outlook and Teams meeting parts need the platform owner to register a Microsoft app.** Until then they run on a mock: in development and tests, never in production.

## 4. Scope

### 4A (no Microsoft account needed)

1. **Excel import:**
   - Settings → Import reads `.xlsx` (the first sheet), with the same preview, mapping, dry run, merging and report as CSV, and the same limits (10,000 rows, 5 MB).
   - `.xls` and `.ods` are still refused, with a clear "save as .xlsx or CSV" message.
2. **Excel downloads:**
   - Reports → "Export Excel" next to "Export CSV" on every tab.
   - Contacts and Leads → "Download Excel" for the current search and filters:
     - up to 50,000 rows;
     - the company's custom fields the member may see;
     - phones masked for members who see them masked;
     - owners and admins only;
     - audited (`contacts.exported`, `leads.exported`).
3. **Live feeds for Excel and Power BI:** `GET /api/public/v1/feeds/{contacts|leads|quotations|orders|products}`.
   - JSON (`{ success, data: [rows] }`) or `?format=csv`.
   - Flat rows with money in rupees, ISO dates and custom fields as `cf_<key>`.
   - At most 100,000 rows; `updatedSince=` gives only the changed ones.
   - Each table needs its existing read scope (`contacts:read` …) and counts in the API calls meter.
   - Settings → API & webhooks gets an **"Excel and Power BI"** card: the feed URLs with Copy, and three numbered steps for Excel (Data → From Web → Advanced) and for Power BI (Get data → Web → Advanced).
4. **English and Hindi** for every new screen text; phones at 390 px.

### 4B (Microsoft 365)

1. **Connect Microsoft 365** (each member, Settings → My profile, like Gmail):
   - sign-in uses the authorization code flow with **PKCE and a single-use state** (10 minutes, `OAuthState` reused with a `provider` field);
   - **least scopes:** `openid email offline_access User.Read Calendars.ReadWrite` (no mail, files or contacts);
   - tokens are encrypted with `secretBox` and refreshed when needed;
   - "Disconnect" deletes the tokens and stops the sync; nothing in the CRM changes.
2. **Outlook calendar (one way, CRM → Outlook):**
   - the member's CRM meetings (events assigned to them, from the day of connecting on) are created, changed and removed in their own Outlook calendar;
   - each event keeps the Outlook id and a sync state (`synced`, `pending`, `failed` with the reason);
   - this runs in the job queue with retries, and is idempotent (a repeated job never creates a second Outlook event);
   - **a Microsoft failure never changes the CRM event;** it only marks the sync state.
3. **Teams meeting link:**
   - on a CRM meeting, "Add Teams meeting" (connected members) creates or updates the Outlook event as an online Teams meeting;
   - the join link is saved on the CRM event and shown with Copy.
4. **Teams channel notes** (Settings → Connections → Teams, owners and admins):
   - paste a Teams Workflows webhook URL (https, on `*.logic.azure.com`, `*.powerplatform.com` or `*.webhook.office.com`) and choose events: **new lead, lead won, quotation accepted, payment received, ticket opened**;
   - each event posts a short card (who, what, value, a link to the CRM) through the job queue with retries;
   - "Send a test" posts a test card (only on the company's own click).
5. **Settings → Connections** shows Microsoft 365 (per member) and Teams notes with their state.
6. **Platform setup:** `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT` (default `common`) and `MICROSOFT_REDIRECT_URI`. The user gets numbered steps (Azure app registration, `.env`, restart), and the code never reads them in tests. With no client id, the Microsoft connection uses the mock when `DEV_TOOLS=on` and says "not set up" otherwise.

## 5. Data model

- **4A:** none. Feeds and exports read the existing records.
- **4B:**
  - `MicrosoftConnection` (new): `organizationId`, `memberId`, `userId`, `email`, `name`, `tenantId`, `encryptedAccessToken`, `encryptedRefreshToken`, `tokenExpiry`, `scopes`, `calendarSyncFrom`, `status` (`active | needs_reconnect`), `lastError`, `lastSyncAt`. Unique on (`organizationId`, `memberId`).
  - `OAuthState` gains `provider` (`gmail` default | `microsoft`) and `codeVerifierEnc` (the PKCE verifier, encrypted).
  - `CalendarEvent` gains `online: { provider, joinUrl }` and `external: { microsoft: { id, syncedAt, state, error } }`.
  - `TeamsChannel` (new, one per company and URL): `organizationId`, `name`, `urlEnc` (the URL holds a secret signature, so it is encrypted), `urlHint` (host and last 6 characters), `events[]`, `active`, `lastStatus`, `lastSentAt`, `lastError`, `createdById`.

## 6. API

All are under `/api/v1` with the usual auth and tenant scope, except the public API.

| Method, path | Who | What |
|---|---|---|
| `GET /contacts/export?format=xlsx\|csv&…list filters` | owners, admins | the contacts list as a file |
| `GET /leads/export?format=xlsx\|csv&…list filters` | owners, admins | the leads list as a file |
| `GET /reports/export?type=…&format=xlsx` | as today (`reports`) | a report tab as .xlsx |
| `POST /contacts/import/preview`, `POST /contacts/import` | as today | now also `.xlsx` |
| `GET /api/public/v1/feeds/:table?format=json\|csv&updatedSince=` | API key with the table's read scope | flat rows |
| `GET /integrations/microsoft` | member | the member's connection (no tokens) |
| `POST /integrations/microsoft/connect` | member | `{ authorizationUrl }` |
| `GET /integrations/microsoft/callback` | Microsoft's redirect | checks state + PKCE, saves tokens, back to Settings |
| `DELETE /integrations/microsoft` | member | disconnect |
| `POST /calendar/events/:id/teams-meeting` | who may edit the event | adds a Teams link: `{ joinUrl }` |
| `GET/POST /integrations/teams-channels`, `PATCH/DELETE /integrations/teams-channels/:id`, `POST …/:id/test` | owners, admins | Teams channel notes |

## 7. Edge cases

- **Excel files:**
  - shared strings, inline strings, numbers, booleans and dates (Excel's day numbers turned into dates where the cell has a date format) are read;
  - formulas give their saved value, and merged cells give the top-left value;
  - empty rows at the end are ignored;
  - a sheet with more than 10,000 rows, a password-protected or broken file get a clear error.
- **Excel cells written** starting with `=`, `+`, `-` or `@` stay text (never a formula).
- **Big exports:** more than 50,000 rows gives a 400 that asks for a narrower filter. Feeds above 100,000 rows ask for `updatedSince`.
- **Tokens:** an expired refresh token, or one revoked in Microsoft, sets `needs_reconnect`. A note asks the member to reconnect, and CRM events keep working.
- **Deletes:** a CRM event deleted while syncing removes the Outlook event once. An Outlook event deleted by hand comes back on the next CRM change (one-way sync).
- **Teams:** a webhook that answers 4xx three times in a row is switched off with the reason. 5xx is retried. The URL is never shown again after it is saved (only its hint).
- **Tenant isolation:** a callback whose state belongs to another company or member is refused. Feeds use the key's company.

## 8. Acceptance checklist

- [ ] A real-structure .xlsx (shared strings, numbers, dates, an empty last row) imports like the same CSV (test).
- [ ] The Contacts and Leads Excel downloads honour the filters, the custom-field access and the phone masking. They are refused to agents and audited (test).
- [ ] The report Excel matches the CSV rows (test).
- [ ] Feeds: the scope is checked, the rows are flat, the money is in rupees, `updatedSince` works, CSV works, and another company's rows never appear (test).
- [ ] OAuth: the state is single-use and tied to the member, PKCE is sent, tokens are stored only encrypted, the scopes are exactly the least set, and disconnect deletes the tokens (test with the mock).
- [ ] Calendar sync:
  - create, change and delete reach Outlook (mock);
  - a repeated job makes no second event;
  - a mock failure marks the sync state and leaves the CRM event unchanged (test).
- [ ] The Teams link is saved on the event (test).
- [ ] Teams notes:
  - a won lead posts one card;
  - a 5xx is retried;
  - a 4xx three times switches it off;
  - URLs off the allowed hosts are refused (test).
- [ ] Browser: Import with .xlsx, Download Excel, the Excel and Power BI card, Connections with Microsoft 365 and Teams, at desktop and 390 px, in English and Hindi.

## 9. Scorecard targets

| # | Target | How it is measured |
|---|---|---|
| 1 | Excel in and out with 0 conversion steps: an .xlsx imports directly; Contacts, Leads and every report download as .xlsx in 1 click | Browser + tests |
| 2 | A live Excel/Power BI feed with 1 URL + 1 header per table and no second product (Zoho: Zoho Analytics or a paid app) | Feed tests; the steps on the card |
| 3 | A CRM meeting reaches Outlook within 1 minute, and a Microsoft failure changes 0 CRM fields | Mock tests (job timing as the queue runs) |
| 4 | A Teams link in 1 click; a won lead in the Teams channel within 1 minute | Tests + browser |
| 5 | Security: a single-use state with PKCE, encrypted tokens, the least scopes, tenant isolation; 390 px and Hindi | Tests + browser |

## 10. What was built (4A, D82), and how it differs from this spec

Built as specified, with these differences:

1. **No library was added.** `utils/xlsx.js` reads and writes .xlsx with Node's own zlib (deflate and CRC-32).
   - Text cells are written as inline strings, so a cell can never become a formula.
   - The header row is bold and frozen, with filters, and dates are real Excel dates (India time).
   - **Excel itself is not installed on this machine.** The files were checked by reading them back, by the browser's XML parser (all 6 parts well-formed), and by importing a downloaded file again. The user should open one downloaded file in Excel once.
2. **"Download Excel" on Customers** asks for lifecycle "customer", as the Customers page shows only customers.
   - The contact search on the server now also looks in **tags**, as the page's own search box does, so the file has the same rows as the screen (checked: 3 of 3 VIP customers, same order).
3. **CSV cells:** numbers are written as numbers, never with an apostrophe.
   - In feeds, a phone number (`+` and digits only) has no apostrophe either: Power Query never runs formulas, and such a value can hold none.
   - Text starting like a formula still gets an apostrophe in every CSV.
4. **The Import button** is now "Import", for CSV and Excel. A damaged .xlsx answers `BAD_EXCEL_FILE`, a password-protected one says so, and `.xls` and `.ods` ask to save as .xlsx or CSV.
5. **The report Excel** has the header in row 1 (frozen), and the report type and range are in the sheet and file names, instead of the CSV's title line.

Files:
- **Backend:**
  - new: `utils/xlsx.js`, `services/tableExportService.js`;
  - changed: `contactService` and `leadService` (`listFilter`, `listSort`; tags in the contact search), `contactImportService` (.xlsx), `reportService` and `routes/reports.js` and `validators/reports.js` (`format=xlsx`), `routes/contacts.js` and `routes/leads.js` (`/export`), `validators/crm.js`, `routes/publicApi.js` and `validators/integrations.js` (`/feeds/:table`).
- **Frontend:**
  - `js/custom-fields.js` (`cfQueryParams`, `cfExportButton`), `customers.html`, `js/customers.js`, `leads.html`, `js/leads.js`;
  - `Reports & Analytics.html`, `js/reports.js`, `Settings.html`, `js/settings-integrations.js`, `css/style.css`;
  - 22 texts (`xl.*`).
- **Tests:** `excel.test.js` (6), and `marketing.test.js` changed (a broken .xlsx and an .xls).

## 11. Phase 4A results (measured 2026-10-21)

Measured in the isolated preview (port 3100, an in-memory database, the tests' sign-in).

| # | Target | Result |
|---|---|---|
| 1 | Excel in and out with 0 conversion steps | **Met.**<br>• The Customers search "VIP" with "Download Excel" gave a file with exactly the 3 customers on screen, in the same order, with the "Credit days" column.<br>• That file imported again through the real preview: 5 rows, with the columns guessed (name, phone, email, company, GSTIN).<br>• Leads and every report tab download as .xlsx with one click.<br>• The tests read an Excel-made file (shared strings, a date style, a scientific number, rich text, empty rows) like a CSV. |
| 2 | A live feed with 1 URL + 1 header per table | **Met.**<br>• The card in Settings → API & webhooks lists the 5 addresses with Copy, and the Excel and Power BI steps.<br>• Called like Excel (CSV, `Authorization: Bearer`): flat rows, money in rupees (₹50,000 and ₹5,00,000 leads), and the custom field as `cf_credit_days`.<br>• `orders` without its scope answered 403. Another company's key sees none of these rows (test). |
| 5 (4A part) | Phones and Hindi | **Met.** Customers, Leads, Reports and the card at 390 px: no sideways scroll (390/390), in Hindi. |

Targets 3 and 4 (Outlook, Teams) belong to 4B.
