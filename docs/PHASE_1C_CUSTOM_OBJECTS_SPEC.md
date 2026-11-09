# Phase 1C: Custom objects and links between records (spec)

Status: **approved with the defaults and built**, 2026-10-17 (decision D75). Section 15 lists where the build differs from this draft. Builds on 1A (D73) and 1B (D74). This is sub-phase 1C of "Deep Customization" in `docs/CRM_10_FEATURE_IMPLEMENTATION_PROMPT.md` (the new master prompt's phase list was never pasted).

## 1. Goal

A company keeps track of its own kinds of records next to its customers, for example **Machines** a customer has installed, **Sites**, **Vehicles**, **AMC contracts** or **Warranties**. Each kind has its own fields (the 1A field engine), is linked to a customer, and shows on that customer's Customer 360. A new field type, **Link**, lets a customer, a lead or one of these records point at another record ("Installed by" → a lead, "Main site" → a Site).

## 2. What exists today (from the code)

- **Fields.** Custom fields exist for `contact` and `lead` only: `CustomFieldDefinition.object` is an enum (`constants/customFields.js` `CUSTOM_FIELD_OBJECTS`). There are 6 types, and no link (lookup) type.
- **Records.** There is no model for a company's own records. Related records today are fixed: tasks and events use `relatedType`/`relatedId` with name snapshots (`constants/crm.js` `RELATED_TYPES`).
- **Menu.** It is plain HTML on each page. `js/app.js` already injects items on every page (`injectGlobalNavItems`, about line 2283), and pages are allowed by module (`PAGE_MODULES`, `canOpenPage`, about line 2069).
- **Access grid.** Modules are a fixed list (`constants/permissions.js` `MODULES`), mirrored in the access grid (`js/accounts.js:85`). `accounts.js` has your uncommitted Hindi edits.
- **Customer 360.** It has fixed tabs: timeline, deals, tasks, tickets, documents, notes and WhatsApp (`customer-360.html:525-531`).
- **Search and export.** Global search groups are fixed (`services/searchService.js`). The full export lists its sections (`services/exportService.js`). Company deletion removes every model with `organizationId` by itself.

## 3. Zoho CRM benchmark (official pages, checked 2026-10-17)

Sources: [Specifications](https://help.zoho.com/portal/en/kb/crm/crm-reference/introduction-to-zoho-crm/articles/specifications-zoho-crm), [Multiple Record Association (linking modules)](https://help.zoho.com/portal/en/kb/crm/customize-crm-account/customizing-modules/articles/linking-modules), [Creating Custom Fields](https://help.zoho.com/portal/en/kb/crm/customize-crm-account/customizing-fields/articles/use-custom-fields).

What Zoho does well:
- **Custom modules by edition:** Free none, Standard 10, Professional 25, Enterprise 200, Ultimate 500.
- **Links:** a lookup links one record (one-to-many). A multi-select lookup links many (many-to-many), with an optional linking module that holds data about each link. Related lists appear on both records by themselves.
- **Field types:** both lookup and multi-select lookup.

Where Zoho is limited (as its own help page says):
- A module can have at most 2 multi-select lookup fields; linking modules hold at most 100 fields.
- Multi-select lookups cannot be filled by import, cannot be used in custom views, and cannot be exported.
- Automation does not run on linking module records.

UNVERIFIED: which editions can build modules today (only an old community post was found), and single lookup fields in views.

Where AgreemCRM 1C will be better (each point can be checked):
- **Every plan has custom objects,** the trial too (Zoho Free has none). The default is 10 per company, the same number as Zoho Standard, not more.
- **Faster setup:** one short form for an object, then the same field screen as 1A.
- **Link fields work everywhere other fields do:** list filters (`is`, `empty`, `filled`), columns and Customer 360. They are never limited to "2 per module".
- **Every record of an object is linked to a customer and appears on that customer's Customer 360** without any setup.

Where it will **not** be better yet:
- No many-to-many links and no linking modules. Zoho's higher editions allow far more modules than our 10.
- No CSV import or export for custom records, no public API or webhooks for them, no reports, no automation on them.
- No layouts or customizable related lists.

## 4. Scope

In 1C:
1. **Custom objects.** Up to 10 per company on every plan. Each has a singular and plural name, an icon (from a short list), a key, and an order. They can be archived and restored, never hard-deleted.
2. **Fields on objects.** The same Settings → Custom fields screen manages them: the switch "Customers | Leads & Deals" gains one button per object. All the 1A and 1B rules apply: 50 fields, required, list columns and filters.
3. **Records.** Each record has a **Name**, an optional **Customer** (a built-in link to a contact), an owner, and the object's custom fields. Records can be added, edited and deleted (soft delete).
4. **A page per object.** One page, `records.html?object=<key>`, serves every object: a list with search, field filters and columns, plus an add/edit form.
5. **Menu.** A **"Your records"** group in the sidebar lists each active object, on every page.
6. **Customer 360.** One tab per object, with that customer's records and an "Add" button that fills in the customer.
7. **New field type "Link".**
   - It is available on customers, leads and objects. It points to one record: a customer, a lead, or a record of one object.
   - The form has a search-and-pick box.
   - Lists, columns and Customer 360 show the linked record's name.
   - Filters: `is`, `empty`, `filled`.
8. **Search and export.**
   - Global search gains a **"Records"** group, matching the name and text fields.
   - The full JSON export gains `customObjects` and `customRecords`.
9. **Texts.** English and Hindi for every new screen text. Object and field names stay as the owner types them.

Not in 1C: many-to-many links; CSV import or export of records; the public API and webhooks for records (links in the public API are returned as the linked record's id); reports; automation; layouts; field rules per role (1E).

## 5. Data model

**`CustomObjectDefinition`** (new):

| Field | Rule |
|---|---|
| `organizationId` | required |
| `key` | `x_` plus a key made from the plural name (`x_machines`); unique per company; fixed after creation. The `x_` prefix keeps it apart from `contact` and `lead`. |
| `singular`, `plural` | 1–40 characters each |
| `icon` | one of about 12 Font Awesome names (box, gear, truck, building, location-dot, file-contract, shield, wrench, bolt, tag, user-gear, warehouse) |
| `order` | |
| `status` | active or archived, plus `archivedAt` |
| `version` | |
| `createdById`, timestamps | |

Archiving hides the object from the menu, Customer 360, forms and link targets. Its records stay, and restoring brings everything back. At most 10 active objects; the count is guarded the same way as 1A fields (`Organization.customFieldsRevision`).

**`CustomRecord`** (new):
- `organizationId`, `object` (the key), `name` (1–200 characters), `contactId` (optional), `ownerId`, `customFields`, `version`, `createdById`, timestamps, soft delete.
- Indexes: `{ organizationId, object, deletedAt, createdAt }`, `{ organizationId, contactId }` and `{ organizationId, object, name }`. The wildcard index of 1B is added on MongoDB 7.0+.

**`CustomFieldDefinition`** (additive changes):
- `object` becomes `contact`, `lead` or an object's key.
- New type `lookup` with `lookupTarget`: `contact`, `lead` or an object's key. It is fixed after creation.
- No migration: existing fields keep their values.

**Link values** are stored as the linked record's id (a string). Responses add `customFieldLinks: { key: { id, name } }`, resolved per page in one query per target. A linked record the viewer may not see shows as `{ id, hidden: true }` and is displayed as "Hidden".

## 6. API

| Method and path | Who | What |
|---|---|---|
| `GET /custom-objects` | anyone who can view customers | active objects (`?status=all` for owner and admin) |
| `POST /custom-objects` | owner, admin | `{ singular, plural, icon }` → 201; 422 `OBJECT_LIMIT` |
| `PATCH /custom-objects/:id` | owner, admin | names, icon, order, `version` |
| `POST /custom-objects/:id/archive`, `/restore` | owner, admin | restore respects the limit |
| `GET /records?object=` | customers: view | `q`, `cf`, `contactId`, paging; agents see their own records unless they have `customers:view_all` |
| `POST /records`, `GET/PATCH/DELETE /records/:id` | customers: create / edit / delete | `{ object, name, contactId?, ownerId?, customFields }`; the 1A required rule (CRM forms only) |
| `GET /lookup?target=&q=` | the target's view permission | up to 20 `{ id, name, subtitle }` the member may see, for the link picker |

Field definitions:
- `/custom-fields?object=x_machines` works for objects too.
- `POST /custom-fields` accepts `type: "lookup"` with `lookupTarget`. A target that is another company's or an archived object is refused.

Checks on link values: 400 with `customFields.<key>`, code `INVALID_LINK`, when:
- the id is malformed;
- the record is in another company;
- the record is deleted;
- the record is of the wrong kind;
- the member may not see the record.

## 7. Permissions (decision 1)

Records, objects and the "Your records" pages follow the **Customers** module:
- view, create, edit and delete as for customers;
- `customers:view_all` to see records owned by others;
- delete needs `customers:delete` for agents, as today.

Owners and admins manage objects. This needs **no change to the access grid** (`js/accounts.js`, which holds your uncommitted edits).

## 8. Screens

- **Settings → Custom fields.**
  - A new **"Objects"** section: add, rename, change the icon, reorder, archive and restore objects, with the count "3 of 10 used".
  - The object switch gains one button per object.
  - The field type list gains **"Link to a record"**, with a "Links to" choice: Customers, Leads, or an object.
- **`records.html?object=x_machines`:** the title is the plural name.
  - A toolbar with search, "Filter by field" (1B) and "New <singular>".
  - The table shows Name, Customer, Owner and up to 3 columns. On phones it shows as cards.
  - The form has Name, Customer (link picker) and More details (the object's fields).
- **Link picker:** a text box. Typing 2 or more letters shows up to 20 matches; the person picks one, and an × clears it.
- **Sidebar:** a "Your records" group with one item per active object (its icon and plural name). It is remembered in the browser so it appears at once, and refreshed in the background. It is hidden for members without Customers access.
- **Customer 360:** one tab per object, "Machines (3)", listing name and columns, with "Add machine" and links that open the record.
- **Phones:** everything works at 390 px with no sideways scrolling.

## 9. Edge cases

- **Object names:** the same plural twice gets a numbered key (`x_machines_2`). Names may be in Hindi; the key then becomes `x_object`, `x_object_2` and so on.
- **Archiving an object:** a link field that points to it stops offering new links. Existing values stay and show the record's name.
- **Deleting a linked record:** the link stays in the database, shows as "—", and the next save clears it.
- **A customer is deleted:** their records keep `contactId`, which then shows as "—". Nothing is deleted with them.
- **Filters on links:** `is` takes an id (pages choose it with the picker), plus `empty` and `filled`.
- **Search:** global search's Records group looks in the name and in the first 20 text fields across objects. It covers up to 5 results per object, at most 3 objects shown.
- **Company deletion** removes `CustomObjectDefinition` and `CustomRecord` by itself (they have `organizationId`).
- **Two admins:** a version conflict gives 409, and the limits are guarded as in 1A.

## 10. Files

New:
- `backend/src/models/CustomObjectDefinition.js`, `models/CustomRecord.js`
- `services/customObjectService.js`, `services/customRecordService.js`, `services/lookupService.js`
- `routes/customObjects.js`, `routes/records.js`
- `tests/customObjects.test.js`
- `crm/frontend/records.html`, `js/records.js`

Changed:
- `constants/customFields.js`, `models/CustomFieldDefinition.js`
- `services/customFieldService.js` (objects, link values), `services/customFieldFilters.js` (link operators, record index)
- `services/contactService.js`, `services/leadService.js` (`customFieldLinks`)
- `services/searchService.js`, `services/exportService.js`
- `validators/customFields.js`, `routes/index.js`
- `crm/frontend/js/app.js` (sidebar group, `PAGE_MODULES`), `js/custom-fields.js` (link input and display), `js/settings-fields.js`, `js/customer-360.js`
- `Settings.html`, `customer-360.html`, `css/style.css`
- `i18n/en.json`, `i18n/hi.json` (only new keys; your uncommitted keys are left alone, as in the 1A/1B commit)
- `docs/BIZNUMA_ROADMAP.md` (D75), `docs/INTEGRATIONS.md` (link values)

No new npm packages, no environment keys, no data migration.

## 11. Acceptance checklist

- [ ] Owner and admin can add, rename, reorder, archive and restore objects. Others get 403. The 11th active object gets `OBJECT_LIMIT`, also in parallel.
- [ ] Objects get fields with every 1A type plus Link; required, list columns and filters work on records.
- [ ] Records: add, edit and delete with the Customers permissions. Agents see only their own unless they have `customers:view_all`. Private numbers' customers stay hidden.
- [ ] Links: every invalid value is refused with `INVALID_LINK`; names resolve in lists; a link the viewer may not see shows "Hidden".
- [ ] Company B can never see, link to, search or filter company A's objects or records.
- [ ] Customer 360 shows one tab per active object with that customer's records.
- [ ] The sidebar shows "Your records" for members with Customers access only.
- [ ] Global search finds records; the full export contains objects and records.
- [ ] The full test suite has no new failures; every new text is in English and Hindi.
- [ ] Settings, the records page, the link picker and Customer 360 work at 390 px (checked in the browser).

## 12. Scorecard targets (goals, not results)

1. **Setup:** create "Machines" with 3 fields and add the first machine to a customer in 3 minutes or less, with 15 clicks or fewer. Clicks are counted in the browser; the time for a person is NOT VERIFIED.
2. **Link safety:** 100% of the invalid link cases are refused in the tests: another company, deleted, wrong kind, archived object, not visible, malformed.
3. **Isolation:** 0 cross-company results through records, links, search, filters and Customer 360 in the tests.
4. **No regressions:** no new failures in the full test suite compared to the 1B commit (772 passed on the committed code alone).
5. **Mobile:** the records page, the form with a link picker, and a Customer 360 object tab at 390 px with no sideways scroll.

## 13. Decisions for you (defaults in bold)

1. **Permissions:** **records follow the Customers module** (no change to the access grid), or a new "Records" module in the access grid. The second needs `js/accounts.js`, which has your uncommitted edits.
2. **Limit:** **10 objects per company on every plan**, or tied to the plans (for example Starter 3, Pro 10, Growth and up 25).
3. **Build order:** **all of 1C in one go, with one report at the end**, or first objects and records (1C-1) with a report, then the Link field (1C-2) after a second OK.

## 14. Test baseline

The 1B commit `6debacb`, run alone, gave **76 suites and 772 tests, all passed**. In the working folder, your uncommitted Hindi work brings back the known `i18n.test.js` Sales Automation failure (and `whatsappAcceptance` can fail on timing). Neither comes from this phase.

## 15. Where the build differs from this draft

1. **The menu is not remembered in the browser.** The project keeps no business data in localStorage (`tests/frontendStorage.test.js`), so "Your records" is asked from the server on every page and appears a moment after the rest of the menu.
2. **Global search** has one "Records" group with the best 5 matches across all objects (newest first), not 5 per object.
3. **Records of an archived object** answer 404, also for owners and admins, until the object is restored.
4. **Link names for a lead** are the lead's title, or else its customer's name. The picker shows the customer and the stage under each lead.
5. **No reordering of objects in the menu by dragging:** objects are reordered with ↑ ↓ in Settings, like fields.
6. **Fewer clicks** (added on 2026-10-18 to meet scorecard target 1):
   - a new object opens its own field list with the add-field form ready;
   - a field's type is chosen with one button instead of a dropdown;
   - after a field is saved the form stays open for the next one ("Done" closes it);
   - Enter on a type button saves the field.

   Measured in the browser at desktop size, from the dashboard to the first machine saved with its customer: **12 clicks** (target 15). The path: Settings, Custom fields, Add object, (Enter), 3 fields with Date and Number chosen by one click each, Your records, Machines, New Machine, customer box and pick, Hours, Save. The time for a person is NOT VERIFIED.
