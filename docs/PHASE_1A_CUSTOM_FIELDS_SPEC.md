# Phase 1A: Custom fields on Customers and Leads (spec)

Status: **approved with the defaults and built**, 2026-10-17 (decision D73). Section 14 lists where the build differs from this draft.

## 1. Goal

An owner or admin adds the company's own fields to Customers and Leads, for example "Machine model", "Credit days", "Visit date" or "Dealer type". The team fills them in the same forms they use today. No code and no training needed.

## 2. What exists today (from the code)

- Contact and Lead have fixed fields only (`models/Contact.js`, `models/Lead.js`). There is no custom-field model or code anywhere.
- Validation drops body fields it does not know (`middleware/validate.js`, `stripUnknown: true`).
- Leads and deals are the same record. The Deals page edits leads (`js/deals.js` `openModal`).
- Settings has 13 tabs, from Profile to Data (`Settings.html:874-911`). Settings endpoints for managers use `requireRole('owner', 'admin')` (for example `routes/bot.js:11`).
- The full JSON export lists its models one by one (`services/exportService.js` `SECTIONS`). Company deletion goes through every model (`services/organizationDeletionService.js:96-97`).
- The public API has its own serializer (`publicApiService.publicContact`), which webhook payloads also use (`services/outboundWebhookService.js:210`).

## 3. Zoho CRM benchmark (official pages, checked 2026-10-17)

Sources: [Specifications](https://help.zoho.com/portal/en/kb/crm/crm-reference/introduction-to-zoho-crm/articles/specifications-zoho-crm), [Creating Custom Fields](https://help.zoho.com/portal/en/kb/crm/customize-crm-account/customizing-fields/articles/use-custom-fields).

What Zoho does well:
- 18 field types: text, integer, decimal, percent, currency, date, date & time, email, phone, pick list, multi-select pick list, URL, text area, checkbox, auto number, lookup, multi-select lookup and long integer.
- Removing a field from a layout moves it to "Unused fields" together with its data, and it can be restored. Only a second, permanent delete loses the data.
- Mandatory fields. Unique fields: 2 per module, 3 for Leads, Contacts, Products and custom modules. Field permissions per profile (Professional and above).

Where Zoho is limited:
- No custom fields in the Free edition. Custom fields per module: Standard 10, Professional 155 (printed that way, possibly a typo), Enterprise 300, Ultimate 500.
- Unused (removed) fields still count toward the limit.
- A field's data type cannot change after it is created.
- Fields are added in a drag-and-drop layout editor (Setup → Customization → Modules and Fields).

UNVERIFIED: limits on pick-list options; whether mandatory fields block the API and imports; any Zoho pricing.

Where YELLOW CRM 1A will be better (each point can be checked):
- Custom fields on every plan, including the trial. Zoho Free has none.
- 50 active fields per object on every plan. Zoho Standard has 10 per module.
- Archived fields do not count toward the 50.
- Adding a field is one short form in Settings, with no layout editor.

Where it will **not** be better yet:
- 6 field types against Zoho's 18 (no lookup, multi-select, currency, auto number, date & time or URL).
- No filters, list columns, import/export mapping or search on custom fields yet (1B).
- No unique fields, no field rules per role (1E), no layouts (1D) and no dependent fields.

## 4. Scope

In 1A:
1. Field definitions per company for two objects: **Customers** (`contact`) and **Leads** (`lead`, also shown on Deals).
2. Six types: Text (up to 255 characters), Long text (up to 2,000), Number, Date, Dropdown (up to 100 options) and Checkbox.
3. Properties: label, help text, required, order, active or archived.
4. A new **Settings → Custom fields** tab (owner and admin): add, edit, reorder, archive and restore.
5. The values appear in the Customer form, the Lead form and the Deal form, and read-only on Customer 360.
6. The server checks every value. Values are saved with the record.
7. The full JSON export includes the field definitions. The values travel inside contacts and leads.
8. English and Hindi for every new screen text.

Not in 1A (later sub-phases): filters, list columns, CSV import mapping, report columns, global search, public API and webhooks (1B); lookups and custom objects (1C); layouts (1D); field visibility per role (1E); automation conditions on custom fields (the workflows phase).

## 5. Data model

New model `CustomFieldDefinition`:

| Field | Rule |
|---|---|
| `organizationId` | required; never taken from the client |
| `object` | `contact` or `lead`; fixed after creation |
| `key` | made from the label, `^[a-z][a-z0-9_]{1,39}$`, unique per company and object; fixed after creation; reserved names refused |
| `label` | 1–60 characters |
| `helpText` | 0–200 characters |
| `type` | `text`, `textarea`, `number`, `date`, `dropdown` or `checkbox`; fixed after creation |
| `options` | dropdown only, up to 100: `{ value, label, archived }`; `value` never changes |
| `required` | default false |
| `order` | position in the form |
| `status` | `active` or `archived`, plus `archivedAt` and `archivedById` |
| `version` | for edits made at the same time |
| `createdById`, `updatedById`, timestamps | |

Indexes: unique `{ organizationId, object, key }`; `{ organizationId, object, status, order }`. Archiving is the only delete in 1A. Nothing is ever hard-deleted.

Contact and Lead each get one additive field, `customFields` (key → value). Old records simply have none, so **no migration is needed**. Stored values:
- text and long text: a trimmed string;
- number: a number;
- date: `YYYY-MM-DD`, an Indian calendar date with no time-zone shift, like task dates;
- dropdown: the option's `value`;
- checkbox: true or false.

An empty value removes the key.

Limit: 50 active fields per object per company, on every plan (a constant in `constants/customFields.js`). The count check and the insert run in one transaction with an atomic counter (`Organization.customFieldCounts`), so two admins adding fields at the same moment cannot pass 50.

## 6. API

All routes are under `/api/v1` and return `{ success, data }`.

| Method and path | Who | What |
|---|---|---|
| `GET /custom-fields?object=contact\|lead` | anyone who can view that module (contact: customers; lead: leads or deals) | active fields in order; `status=all` (archived too) for owner and admin only |
| `POST /custom-fields` | owner, admin | `{ object, label, type, helpText?, required?, options? }` → 201; 422 `FIELD_LIMIT` |
| `PATCH /custom-fields/:id` | owner, admin | label, help text, required, options (add, rename, archive an option), `version`; changing type, key or object → 400; stale `version` → 409 `VERSION_CONFLICT` |
| `POST /custom-fields/:id/archive` | owner, admin | hides the field; the values stay |
| `POST /custom-fields/:id/restore` | owner, admin | brings it back; 422 `FIELD_LIMIT` if 50 are active |
| `POST /custom-fields/reorder` | owner, admin | `{ object, ids }`; every id must be one of this company's active fields for that object |

The existing Contacts and Leads routes change additively:
- `POST` and `PATCH` accept `customFields: { key: value }`. A PATCH changes only the keys it sends; `null` or `""` clears one.
- `GET` and the lists return `customFields` with the values of active fields only. A restored field shows its old values again.
- Errors name the field: 400 `VALIDATION_ERROR` with details `{ field: "customFields.<key>", code, message }`. The codes are `UNKNOWN_FIELD`, `FIELD_ARCHIVED`, `INVALID_TYPE`, `INVALID_OPTION`, `TOO_LONG` and `REQUIRED`.
- The public API ignores `customFields` in 1A and does not return them (1B).

Required fields are enforced when a person creates a record in the CRM's own forms. A PATCH that sends an empty value for a required field is refused. Required fields are **not** enforced for WhatsApp chats, lead sources, website forms, CSV import, the public API, or edits that do not touch the field. So adding a required field never stops incoming leads or a running integration.

Permissions and safety:
- Values are edited with the existing `customers:edit` and `leads:edit` permissions. The record's own visibility rules apply (`services/access.js`).
- There is no phone type in 1A, because phone masking (`middleware/phoneMasking.js`) only knows the built-in phone fields.
- Audit entries: `custom_field.created`, `.updated`, `.archived`, `.restored` and `.reordered`. Record edits are already audited with the changed keys.

## 7. Screens

- **Settings → Custom fields** (owner and admin; hidden for everyone else). A switch between "Customers" and "Leads & Deals". Each row shows label, type and required, with ↑ ↓, Edit and Archive. The archived fields sit in a closed section with Restore. The "Add field" form has label, type, help text, required, and dropdown options one per line. A counter shows "12 of 50 used".
- **Customer, Lead and Deal forms**: a "More details" section under the existing fields, built from the definitions. Required fields are marked with *, help text sits under the input, and a server error appears next to its field.
- **Customer 360**: a read-only "More details" card with the filled values.
- At 390 px every field takes a full row, with no sideways scrolling.
- A new shared script `js/custom-fields.js` draws and reads the inputs. Its names start with `cf` to avoid clashes in the shared global scope (`frontendScripts.test.js` checks this). Every value is escaped before it is shown.

## 8. Edge cases

- The type is fixed after creation (Zoho works the same way). To change it, create a new field.
- A removed dropdown option is archived. Old values stay and show as "label (removed)"; it cannot be picked again.
- An archived field keeps its values in the database, hidden from forms and responses. Restore shows them again.
- A field made required later does not change old records. The next time someone saves that record's form, they are asked to fill it.
- The same label twice: the second key gets a number (`visit_date_2`). Reserved names (`constructor`, `prototype` and similar) are refused. The existing unsafe-key middleware already refuses `__proto__` and `$` keys.
- Number: a finite number between −1,000,000,000,000 and 1,000,000,000,000, with at most 2 decimal places.
- Date: a real calendar date (`2026-02-30` is refused).
- Two admins editing the same field: the second one gets 409 and reloads.
- Company B sending company A's field id or key: 404 or `UNKNOWN_FIELD`.
- At most 50 keys in one `customFields` body.
- A page still cached without the new script saves fine: no `customFields` means nothing changes.

## 9. Files

New:
- `backend/src/models/CustomFieldDefinition.js`
- `constants/customFields.js`
- `services/customFieldService.js`
- `validators/customFields.js`
- `routes/customFields.js`
- `tests/customFields.test.js`
- `crm/frontend/js/custom-fields.js`
- `js/settings-fields.js`

Changed:
- `models/Contact.js`, `models/Lead.js`, `models/Organization.js` (the counter)
- `services/contactService.js`, `services/leadService.js`, `services/exportService.js`
- `validators/crm.js`
- `routes/index.js`, `routes/contacts.js`, `routes/leads.js`
- `Settings.html`, `customers.html`, `leads.html`, `Deals.html`, `customer-360.html`
- `js/customers.js`, `js/leads.js`, `js/deals.js`, `js/customer-360.js`, `js/settings.js`
- `i18n/en.json`, `i18n/hi.json`
- `docs/BIZNUMA_ROADMAP.md` (decision D73 and the changelog)

No new npm packages, no new environment keys, no data migration.

## 10. Acceptance checklist

- [ ] Owner and admin can add, edit, reorder, archive and restore fields. Agent and viewer get 403 on every write.
- [ ] Agents and viewers can read the active fields of modules they can view, and get 403 for other modules.
- [ ] The server refuses a wrong value for every type and names the field in the error.
- [ ] Unknown keys, archived keys and other companies' keys are refused.
- [ ] Company B cannot see, edit, use or restore company A's fields, by id or by key.
- [ ] The 51st active field gets `FIELD_LIMIT`, also when the requests arrive in parallel.
- [ ] Archive keeps the values, and restore shows them again.
- [ ] Required fields work in the CRM forms. WhatsApp, lead sources, website forms, import and the public API still create records.
- [ ] Records without custom fields load and save exactly as before. The test suite has no new failures.
- [ ] The full JSON export contains the field definitions and the values.
- [ ] Every new screen text is in `en.json` and `hi.json` (`i18n.test.js`).
- [ ] The Settings tab and the customer, lead and deal forms work at 390 px and on desktop (checked in the browser).
- [ ] The audit log has an entry for every field change.

## 11. Scorecard targets (goals, not results)

1. **Setup speed:** an owner adds a Dropdown field with 3 options and fills it on a customer in 90 seconds or less, with 8 clicks or fewer (measured once in the browser).
2. **Validation:** the server refuses 100% of the invalid-value test cases, covering all 6 types.
3. **Isolation:** 0 cross-company reads or writes in the isolation tests.
4. **No regressions:** no new failures compared to today's baseline (676 passed, 3 known failures, see section 13).
5. **Mobile:** the add-field form, and a customer form with 10 custom fields, at 390 px with no sideways scroll.

## 12. Decisions for you (defaults in bold)

1. Limit: **50 active fields per object on every plan**, or tied to the plans (for example Starter 20, Pro 50).
2. Required fields apply **only in the CRM's own forms** (WhatsApp, lead sources, import and API are never blocked).
3. Hindi texts and git: `en.json` and `hi.json` already hold your uncommitted Hindi edits. **I add my texts to the same files, stay on `feature/hindi-pages` and commit nothing until you say so.**

## 13. Test baseline (2026-10-17, before any 1A code)

Run with `npx jest` from `backend/`, on `feature/hindi-pages` with your uncommitted frontend edits: **74 suites, 679 tests: 676 passed, 3 failed, in 139 s.**

Known failures, none caused by me:
1. `i18n.test.js`: "Sales Automation.html uses only keys that exist". The page (uncommitted) uses 75 `auto.*` keys, and `en.json`/`hi.json` do not have any `auto.` key yet. This is your Hindi work in progress.
2. and 3. `whatsappAcceptance.test.js`: the read tick did not arrive in time, and the second test failed because of the first. Run alone, the file passed (3 of 3). The tests depend on timing under parallel load (flaky); not a code bug as far as this run shows.

## 14. Where the build differs from this draft

1. **The limit's guard.** There is no `Organization.customFieldCounts` counter. Adding or restoring a field raises `Organization.customFieldsRevision` inside the same transaction, so two admins doing it at the same moment are taken one after the other and the count always comes from the fields themselves (it cannot drift). Tested with three parallel requests for the last place.
2. **One more error code.** `OUT_OF_RANGE`: a number above 1,000,000,000,000 or with more than 2 decimal places.
3. **Customer 360.** The filled values are rows in the existing Overview panel, under the built-in ones, instead of a separate card.
4. **Checkbox.** Unticked counts as empty, so a required checkbox must be ticked.
5. **When "required" applies.** On a new record whenever the request sends `customFields`. The customer, lead and deal forms always send it. Other places that create records (WhatsApp, lead sources, import, the public API, and quick adds elsewhere in the CRM) never send it.
