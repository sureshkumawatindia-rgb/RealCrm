# Phase 1B: Custom fields in lists, import, the API, webhooks and search (spec)

Status: **approved with the defaults and built**, 2026-10-17 (decision D74). Builds on Phase 1A (D73, `docs/PHASE_1A_CUSTOM_FIELDS_SPEC.md`). Section 16 lists where the build differs from this draft.

## 1. Goal

The fields a company added in 1A become useful everywhere a team looks for or moves data:
- filter the Customers, Leads and Deals lists by them;
- show up to three of them as columns;
- fill them from a CSV file;
- read and write them through the public API, and receive them in webhooks;
- find records by them in search.

## 2. What exists today (from the code)

- **Lists filter in the browser.** The Customers, Leads and Deals pages load their records into the browser (`crmLoad`, up to 50 × 100) and filter there (`js/customers.js` `renderTable`: search and status). On phones, tables become cards from the column headers (`js/app.js:1902`).
- **List APIs.** `GET /contacts` and `GET /leads` filter on the server with fixed parameters (`services/contactService.js` `list`, `services/leadService.js` `list`). Unknown query keys are dropped (`stripUnknown`). Express 5's query parser does not read `a[b]=c`, but it does read a repeated `a=1&a=2` as a list.
- **Search.** Global search (top bar) calls the same list functions with `q` (`services/searchService.js`), a case-insensitive pattern over fixed fields (`utils/listQuery.js` `searchFilter`).
- **Import.** CSV import exists for customers only: preview, mapping, dry run, then import (`services/contactImportService.js`). Its fixed targets are `FIELDS`, guessed from header names (`GUESSES`). Up to 10,000 rows and 5 MB per file; Excel files are refused with a hint. People already in the CRM only get blank fields filled.
- **Public API.** `/api/public/v1` returns its own shapes (`publicContact`, `publicLead` in `services/publicApiService.js`). It has its own validators (`validators/integrations.js`), so `customFields` is dropped there today.
- **Webhooks.** Payloads reuse the same shapes (`services/outboundWebhookService.js:205-237`). Events: `lead.created`, `lead.stage_changed`, `contact.created`, `message.received`, `quotation.status_changed`, `order.created`, `order.stage_changed` and `payment.received` (`constants/api.js:17-26`). The API and webhooks need a plan with `api` (Growth and up).
- **MongoDB.** The tests run MongoDB 8.2.6 (mongodb-memory-server 11.3.0). The production version (Atlas) is **UNVERIFIED**.

## 3. Zoho CRM benchmark (official pages, checked 2026-10-17)

Sources:
- [FAQs: List Views](https://help.zoho.com/portal/en/kb/crm/faqs/list-view/articles/faqs-list-views-in-zoho-crm)
- [Import data into a CRM module](https://help.zoho.com/portal/en/kb/crm/data-administration/import-data/articles/import-data-into-a-crm-module)
- [FAQs: Import](https://help.zoho.com/portal/en/kb/crm/faqs/data-administration/import/articles/faqs-import)
- [Zoho developer docs: Webhooks](https://www.zoho.com/developer/help/extensions/automation/webhooks.html)
- [Create Custom Field API](https://www.zoho.com/crm/developer/docs/api/v8/create-custom-field.html)

What Zoho does well:
- **List views.** Custom views filter on standard and custom fields, with up to 25 criteria joined by AND/OR patterns. Users with the "Manage Custom Views" permission choose and order the columns. The pages do not name the editions, so these limits per edition are UNVERIFIED.
- **Import.**
  - Accepts CSV, XLS, XLSX (and VCF for some modules), up to 25 MB, 500 columns, and rows by edition: Free 1,000; Standard 20,000; Professional 50,000; Enterprise 100,000; Ultimate 200,000.
  - Columns are auto-mapped by name, and new fields can be created during the import.
  - A column maps only to a field of the same data type. The date and number format is picked per column.
  - Re-imports update records found by a unique field, with an option to skip empty values.
- **API.** Custom fields have API names and a "filterable" property.

Where Zoho is limited:
- **Dropdowns on import.** The import FAQ lists a failure when a file's value is not already a choice of the dropdown.
- **Mandatory fields on import.** "Records with missing mandatory fields will not be imported."
- **Webhooks.** Zoho's developer docs say a webhook sends at most 10 CRM fields, and a workflow rule has at most 6 webhooks. That page may be dated, so this is UNVERIFIED for today's editions.

UNVERIFIED: whether Zoho's global search covers custom fields (only community posts were found), Zoho pricing, and per-edition limits on views.

Where YELLOW CRM 1B will be better (each point can be checked):
- **Indian formats on import.** Numbers like `1,25,000` or `₹ 2,500` and dates like `20/10/2026` are read without choosing a format per column. A dropdown matches its choice by name, ignoring capitals.
- **No row is dropped for a required custom field** (D73); the report says what was left out and on which row.
- **Webhooks carry every custom field** of the contact or lead, not a chosen 10.
- **Custom fields are on every plan.** The API and webhooks still need Growth and up, as today.

Where it will **not** be better yet:
- Filters are AND only: 5 per request, 3 on a page. There are no OR patterns and no saved, named views (Zoho: 25 criteria with patterns).
- Import stays CSV only, customers only, 10,000 rows and 5 MB per file. It cannot create fields during the import.
- There is no sorting by a custom column.

## 4. Scope

In 1B:
1. **Filters.** On the list APIs (`/contacts`, `/leads`, and the public API lists) and on the Customers, Leads and Deals pages.
2. **List columns.** Up to 3 per object, chosen by owners and admins.
3. **CSV import mapping.** Custom fields of customers as import targets, with auto-match by name.
4. **Public API.** Custom fields in contact and lead responses, a read-only definitions endpoint, writes on contacts, and filters.
5. **Webhooks.** Custom fields inside the contact and lead objects of existing events.
6. **Search.** Custom text, long text and dropdown fields in global search and in the list searches.

Not in 1B: OR logic and saved views; sorting by custom fields; lead or product import; CSV export of lists; Excel files; automation conditions on custom fields; new field types (phone, email, URL, lookup); field rules per role (1E).

## 5. Filters

### 5.1 API (`GET /contacts`, `GET /leads`, `GET /api/public/v1/contacts`, `GET /api/public/v1/leads`)

The parameter `cf` can be repeated, up to 5 times: `cf=<key>:<operator>[:<value>]`. All filters must match (AND). They combine with the existing filters, the search, the visibility rules and private numbers.

| Type | Operators | Value |
|---|---|---|
| text, long text | `has` (contains, ignoring capitals), `is` (exactly, ignoring capitals), `empty`, `filled` | up to 100 characters |
| number | `eq`, `gt`, `gte`, `lt`, `lte`, `empty`, `filled` | a number (`1,25,000` is read as 125000) |
| date | `eq`, `before`, `after`, `from`, `to`, `empty`, `filled` | `YYYY-MM-DD` |
| dropdown | `in`, `empty`, `filled` | choice values separated by commas, up to 20 (archived choices allowed, since records may still have them) |
| checkbox | `yes`, `no` | none |

- An unknown key, an archived field, an operator the type does not have, or a bad value gets 400 `VALIDATION_ERROR` with field `cf` and code `INVALID_FILTER`.
- `empty` matches records without a value, including records saved before the field existed.
- **Index:** `{ organizationId: 1, 'customFields.$**': 1 }` on Contact and Lead (a compound wildcard index). It needs **MongoDB 7.0 or newer**, so it is created at startup only when the server is 7.0+. On an older server the filters still work, only slower, and a warning is logged once.

### 5.2 Pages (Customers, Leads, Deals table and board)

- A **"Filter by field"** button opens a small form: field → condition → value. Each active filter shows as a chip with ×. There can be up to 3 chips, combined with the page's own search and filters.
- The matching runs in the browser on the records the page already has, like the existing filters. It uses one shared function in `js/custom-fields.js`, tested against the same table of cases as the server.
- Each person's chips are remembered in their own browser (a convenience only). A chip for a field that was archived or deleted since is dropped quietly.
- On phones the form takes the full width, and the chips wrap.

## 6. List columns

- A new field setting, **"Show as a column in lists"** (`listColumn`), set in Settings → Custom fields. At most 3 per object; a 4th gets 422 `COLUMN_LIMIT`.
- **Customers** and **Leads** tables show the chosen fields after the built-in columns, and so does the **Deals** table (not the board cards).
- Values are shown the way Customer 360 shows them: a dropdown's choice name, dates as "20 Oct 2026", numbers in Indian style, a tick as "Yes".
- On phones the cards get the same rows automatically (they are built from the table headers).
- The choice is **company-wide**: everyone sees the same columns (decision 1).

## 7. CSV import mapping (customers)

- **Preview.** The preview also returns the active customer fields as targets: `{ value: "cf:<key>", label, type }`. The column choice list shows them under "Your fields".
- **Auto-match.** A header that equals a field's name or key (ignoring capitals, spaces and punctuation) is matched to it. Built-in fields win a tie, and each field is matched once.
- **Validation.** `mapping` items may be `cf:<key>`. An unknown or archived key gets 400.
- **Reading values** (more forgiving than the form; a value that cannot be read is left out with a warning naming the row):

| Type | Read as |
|---|---|
| text, long text | trimmed; text that is too long is cut, with a warning |
| number | spaces, commas, `₹`, `Rs`, `Rs.` and `INR` removed; then at most 2 decimal places |
| date | `YYYY-MM-DD`, `DD/MM/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`, always day first (never US month-first); a 4-digit year is required |
| dropdown | a choice's name (ignoring capitals and spaces) or its value; an unknown or archived choice is left out with a warning (decision 3) |
| checkbox | yes / no / y / n / true / false / 1 / 0 / हाँ / नहीं (ignoring capitals) |

- **Same rules as the built-in fields:**
  - Rows of the same file for the same person merge, filling blanks.
  - People already in the CRM only get **empty** custom fields filled; nothing is overwritten.
  - Required fields are never enforced (D73).
  - The dry run reports without saving.
  - The report counts the custom values that were left out.

## 8. Public API and webhooks

- **New endpoint.** `GET /api/public/v1/custom-fields?object=contact|lead` (scope `contacts:read` for contact, `leads:read` for lead) returns the active fields: `key`, `label`, `type`, `required`, and `options` (`value`, `label`) for dropdowns.
- **Reads.** Contacts and leads (lists, single records and the contact inside a lead) gain `customFields: { key: value }`, with active fields only.
  - Dropdowns are returned as the **choice name** (decision 2); renaming a choice changes what integrations receive.
  - Dates are `YYYY-MM-DD`, numbers are numbers, and ticks are `true` (unticked fields are absent).
- **Writes.** `POST` and `PATCH /api/public/v1/contacts` accept `customFields`, checked with the same rules as the CRM. A dropdown takes a choice name or value. The public API never gets `REQUIRED` errors (D73).
  - Leads are not written through the public API in 1B. Its `POST /leads` is the enquiry path, and setting fields there could overwrite an open lead.
- **Filters.** `cf` works on the public lists (section 5.1).
- **Webhooks.** The `contact` and `lead` objects inside existing events carry `customFields` in the same shape. The change is additive: the same events and headers, and the signature still covers the whole body. `docs/INTEGRATIONS.md` gets the new field and the endpoint.

## 9. Search

- **What is searched.** The search term is also looked for in active **text** and **long text** fields, and in **dropdown** fields whose choice name contains it. It applies to global search (top bar) and to `q` on `/contacts` and `/leads`, plus the lead's own fields for leads.
- **Page search boxes.** The search boxes on the Customers, Leads and Deals pages (in the browser) do the same.
- **Not searched.** Numbers, dates and ticks.
- **Unchanged.** Visibility, private numbers and phone masking. Custom fields have no phone type, so nothing new needs masking.
- **Speed.** The search is a case-insensitive pattern, like today's search, so it uses no index. With many fields on a big company it gets slower. A limit of the first 20 text fields per object keeps it bounded.

## 10. Data model and files

Data model:
- `CustomFieldDefinition` gets one additive field, `listColumn: Boolean` (default false).
- Contact and Lead get the wildcard index above (when MongoDB allows it).
- No data migration.

Files.

New:
- `backend/src/services/customFieldFilters.js`: parses `cf` into a query, and reads import values.
- `backend/src/tests/customFieldsLists.test.js`

Changed:
- `models/CustomFieldDefinition.js`, `models/Contact.js`, `models/Lead.js`
- `services/customFieldService.js`, `contactService.js`, `leadService.js`, `contactImportService.js`, `publicApiService.js`, `outboundWebhookService.js`
- `validators/crm.js`, `validators/marketing.js`, `validators/integrations.js`, `validators/customFields.js`
- `routes/publicApi.js`
- `server.js` (index check)
- `crm/frontend/js/custom-fields.js`, `settings-fields.js`, `customers.js`, `customers-import.js`, `leads.js`, `deals.js`
- `Settings.html`, `customers.html`, `leads.html`, `Deals.html`, `css/style.css`
- `i18n/en.json`, `i18n/hi.json`
- `docs/INTEGRATIONS.md`, `docs/BIZNUMA_ROADMAP.md` (D74)

No new npm packages, no new environment keys.

## 11. Edge cases

- **Combining filters.** Filters and search together: the search's "any of these fields" and the filters' "all of these" are combined correctly. This is tested with records that match only one of them.
- **Old records.** A filter on a field that no record has yet returns nothing for `is`, and every record for `empty`.
- **Renamed choices.** API reads show the new name; stored values do not change.
- **Import headers.** A file header that matches both a built-in field and a custom field goes to the built-in one, and the person can change it. Two custom fields with the same name: the first is matched.
- **Field archived meanwhile.** Its column, filter chip and import target disappear; its values stay (1A).
- **Agents.** They filter and search only the records they may see; filters never reveal records they cannot open.
- **Payload size.** With 50 fields of 2,000 characters, a webhook can grow to about 100 KB; webhook deliveries already send whole records.

## 12. Acceptance checklist

- [ ] Every type and operator in 5.1 returns exactly the right records (each case tested on the server), and wrong filters get `INVALID_FILTER`.
- [ ] The page filter function gives the same answers as the server for the same table of cases.
- [ ] Filters respect visibility, private numbers and the other company (company B's keys get `INVALID_FILTER`; no leak).
- [ ] At most 3 list columns per object; columns show on Customers, Leads and Deals, and as rows on phone cards.
- [ ] Import fills custom fields from Indian formats and reports what it left out, row by row; existing values are never overwritten; required fields never drop a row.
- [ ] The public API returns `customFields` for contacts and leads, writes them on contacts, lists definitions, and filters by `cf`; an API key from company B sees nothing of company A.
- [ ] Webhook payloads for `contact.created`, `lead.created` and `lead.stage_changed` contain `customFields`.
- [ ] Global search and the list searches find records by a custom text value and by a dropdown choice name.
- [ ] The full test suite has no new failures; every new screen text is in English and Hindi.
- [ ] Customers, Leads, Deals and Settings work at 390 px with no sideways scroll (checked in the browser).

## 13. Scorecard targets (goals, not results)

1. **Import accuracy:** a test file of 1,000 rows with 6 custom columns in Indian formats imports 100% of the readable values correctly, and reports 100% of the unreadable ones with their row numbers (automated test).
2. **Filter correctness:** 100% agreement between the server and the page filter on the shared table of cases, covering every type and operator (automated test).
3. **Speed:** `GET /contacts` with 2 custom-field filters on 20,000 contacts with 20 fields each answers within 300 ms at p95, measured locally with the index (not production).
4. **Isolation:** 0 cross-company results through filters, search, the API and webhooks in the tests.
5. **Mobile:** filter chips, the filter form and 3 custom columns at 390 px with no sideways scroll.

## 14. Decisions for you (defaults in bold)

1. List columns: **chosen by owners and admins for the whole company, at most 3 per object**, or each person picks their own (saved per browser).
2. Dropdowns in the public API and webhooks: **the choice name** ("Wholesale"), or the stored value ("o2").
3. A dropdown value in a CSV file that is not one of the choices: **left out with a warning**, or added as a new choice automatically.

Not a decision, but helpful: if you know your Atlas MongoDB version (Atlas → your cluster → "Version"), tell me. The index needs 7.0 or newer, and the build checks it by itself either way.

## 15. Test baseline (after 1A, 2026-10-17)

`npx jest` from `backend/`: **75 suites, 704 tests: 703 passed, 1 failed**. The failure is the known `i18n.test.js` "Sales Automation.html uses only keys that exist" (75 `auto.*` keys from the uncommitted Hindi work). `whatsappAcceptance.test.js` passed in this run; it failed in the first baseline because of timing. Nothing is committed yet.

## 16. Where the build differs from this draft

1. **Where the import code lives.** Reading CSV values (Indian numbers, dates, choice names, yes/no) sits in `services/customFieldService.js`, next to the other value rules, not in `customFieldFilters.js`. `routes/contacts.js` also changed: the import preview now needs the signed-in company to list its fields.
2. **Lead search.** A lead's search also looks in its contact's custom text fields and choice names, not only in the lead's own.
3. **Search limit.** The server searches the first 20 text fields per object. The page search boxes look in all of them, because the records are already in the browser.
4. **Hindi chips.** The Hindi condition words carry their own colon ("Credit days इससे ज़्यादा: 30"), so a chip reads naturally without a separate template.
5. **One 1A test changed on purpose.** `tests/customFields.test.js` checked that the public API ignored custom fields; since 1B the API saves them, so the test now checks that it does.
6. **Webhook payloads.** `dataOf` in `services/outboundWebhookService.js` is exported, so the tests can check the payload directly.
