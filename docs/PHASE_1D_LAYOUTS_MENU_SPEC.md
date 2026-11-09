# Phase 1D: Field sections (layouts) and the company menu (spec)

Status: **approved 2026-10-20 with the three defaults, and built (not committed)**. What was built and how it differs from this spec is in sections 14 and 15. This is sub-phase 1D ("layouts/apps/menus") of "Deep Customization" in `docs/CRM_10_FEATURE_IMPLEMENTATION_PROMPT.md`, and it builds on 1A–1C (D73–D75).

## 1. Goal

Two small things that make the CRM feel like the company's own, without training:

1. **Sections:** a company with many of its own fields groups them under headings ("Machine details", "Service", "Payment terms"), in one or two columns. Long forms become short and easy to scan.
2. **A tidy menu:** a company that does not use some pages (for example Marketing, Support or AI Insights) hides them from everyone's menu and search, and can show them again at any time.

## 2. What exists today (from the code)

- **Custom fields in forms.** They are drawn in one list under "More details" (`js/custom-fields.js` `cfRender`), in the order set in Settings → Custom fields. Customer 360 shows the filled ones as rows in Overview (`js/customer-360.js` `renderFields`).
- **The menu.** It is plain HTML on each page. `js/app.js` hides the pages a member has no access to (`hideUnavailableModules`, `canOpenPage`), and adds "Your records" (D75).
- **Company switches.** Company-wide settings live in `Organization.settings` (`hidePhonesFromAgents`, `sendReadReceipts`). They are read and changed through `GET/PATCH /organization/settings` (`routes/organization.js:51-54`, `services/teamSettingsService.js`).
- **`/auth/me`.** It returns the company's `id`, `name` and `logoUrl` (`services/authService.js` `me`). The browser keeps a copy of name and logo in `crm_company` (allowed by `tests/frontendStorage.test.js`).
- **Global search.** It shows a group for every module the member may view (`services/searchService.js`).

## 3. Zoho CRM benchmark (official pages, checked 2026-10-20)

Sources:
- [Page Layouts](https://help.zoho.com/portal/en/kb/crm/customize-crm-account/customizing-page-layouts/articles/create-page-layouts)
- [Page Layouts – FAQ](https://help.zoho.com/portal/en/kb/crm/customize-crm-account/customizing-page-layouts/articles/page-layout-faq)
- [Customization: Part 1 (PDF)](https://www.zoho.com/sites/default/files/crm/customization-part1.pdf)

What Zoho does well:
- **Layouts.** Fields are grouped into sections, and each section is one or two columns. A module can have several layouts, each given to profiles (roles), and admins can preview a layout as a profile. Required fields and choice lists can differ by layout.
- **Menu.** "Organize Modules" shows, hides and reorders the module tabs, and "Tab groups" give profiles their own sets of tabs.

Where Zoho is limited:
- **Layouts may need the top edition.** The FAQ gives "You are not in the Enterprise Edition of Zoho CRM" as a reason someone cannot create a layout. The edition table is not on the page, so this is UNVERIFIED.
- **Field permissions are not per layout.** They apply to every layout of a module.
- **Tab groups cannot be reordered.** Zoho staff said so in an older community thread, so this is UNVERIFIED for today.

Where AgreemCRM 1D will be better (each point can be checked):
- **Every plan** gets sections and two columns, the trial too.
- **One screen:** sections are made on the same Settings screen as the fields; there is no separate layout editor.
- **Hidden pages also leave global search,** not only the menu.

Where it will **not** be better yet:
- Only **one layout per object** for the whole company. There are no layouts per role and no "preview as": that belongs to 1E (rules per role).
- The menu can only hide pages, not reorder them, and there are no tab groups per role.

## 4. Scope

In 1D:
1. **Sections** for the custom fields of customers, of leads & deals, and of each object:
   - each has a name and 1 or 2 columns;
   - they can be reordered with ↑ ↓ and removed;
   - up to 10 sections per object;
   - fields without a section stay under "More details", as today.
2. **A "Section" choice** on each custom field, in its add/edit form.
3. **Forms show the sections:** the customer, lead, deal and record forms, and Customer 360's Overview with small section headings.
   - A 2-column section is 2 columns on wide screens and 1 column on phones.
   - A section with no active fields is not shown.
4. **The company menu,** in Settings → Team & Access: "Pages your company uses", one switch per page.
   - A page switched off disappears from **everyone's** menu (owners and admins too) and from global search.
   - Dashboard, Customers and Settings cannot be switched off.
   - Turning a page back on brings it back; no data is touched.
5. **English and Hindi** for every new screen text.

Not in 1D: layouts per role; required fields per layout; reordering the whole menu; per-person menus; dashboards.

## 5. Data model

**`CustomFieldLayout`** (new), one per company and object:

| Field | Rule |
|---|---|
| `organizationId` | required |
| `object` | `contact`, `lead` or an object's key (`x_…`); unique per company with `organizationId` |
| `sections` | up to 10: `{ id: "s1", label (1–40), columns: 1 or 2 }`; the array order is the display order; an `id` never changes |
| `version` | for edits made at the same time |
| `updatedById`, timestamps | |

**`CustomFieldDefinition`** gets one additive field, `sectionId`. An empty `sectionId` means "More details". Removing a section clears `sectionId` on its fields, inside the same transaction, so no field is lost.

**`Organization.settings.hiddenModules`** is a list of module keys from `constants/permissions.js` `MODULES`, except `dashboard`, `customers` and `settings`. Missing means every page is used, as today.

No data migration: everything is additive.

## 6. API

| Method and path | Who | What |
|---|---|---|
| `GET /custom-fields/layout?object=` | anyone who can view that object | `{ object, sections, version }`; an empty `sections` when none was made |
| `PUT /custom-fields/layout` | owner, admin | `{ object, sections: [{ id?, label, columns }], version }`. A new section gets the next `id`. A section left out is removed and its fields go to "More details". A stale `version` gets 409. More than 10 sections gets 422 `SECTION_LIMIT`. |
| `POST`/`PATCH /custom-fields` | owner, admin | also accept `sectionId` (`null` = "More details"); an unknown `sectionId` gets 400 `INVALID_SECTION` |
| `GET /organization/settings` | members, as today | also `hiddenModules` |
| `PATCH /organization/settings` | owner, admin | also `hiddenModules: [keys]`; Dashboard, Customers or Settings get 400; the change is audited |
| `GET /auth/me` | everyone | `organization.hiddenModules`, so every page hides them at once (kept with the company's name and logo in `crm_company`) |

**Global search** leaves out the groups of hidden pages. **Permissions do not change:** a hidden page is tidying-up, not security. A direct link still opens it for members who have access (decision 2).

## 7. Screens

- **Settings → Custom fields.** Under the field list of the chosen object, a **"Sections"** box:
  - each row has the name, "1 column / 2 columns", ↑ ↓ and Remove;
  - "Add section" adds one;
  - "Save sections" saves them.

  In the add/edit field form there is a new **Section** choice. Each field row gets a small badge with its section's name.
- **Forms** (customer, lead, deal, record). "More details" becomes the sections in order, each with its heading, then "More details" for the fields without a section.
- **Customer 360 → Overview.** The filled values are grouped under small section headings.
- **Settings → Team & Access.** A **"Pages your company uses"** block with one switch per page (Inbox, Leads, Deals, Tasks, Calendar, Marketing, Sales Automation, Support, Reports, AI Insights, Documents, Products, Account Champions). Each switch is saved at once.
- **Phones.** Everything works at 390 px with no sideways scrolling, and 2-column sections become 1 column.

## 8. Edge cases

- **Removing a section** never removes fields: they move to "More details".
- **An archived field** keeps its `sectionId`. If it is restored after its section was removed, it goes to "More details".
- **Two admins** editing sections at the same time: the second gets 409 and reloads.
- **A company hides a page an agent is on:** the agent's menu updates on their next page load (`/auth/me` is read on every page).
- **Quotations and Orders** follow the Leads/Deals pages, as their access does today. They are not separate switches.
- **Another company** can never read or change these sections or settings; every query is scoped to the company.

## 9. Files

New:
- `backend/src/models/CustomFieldLayout.js`
- `backend/src/services/fieldLayoutService.js`
- `backend/src/tests/fieldLayouts.test.js`

Changed:
- **Backend:**
  - models: `CustomFieldDefinition.js` (`sectionId`), `Organization.js` (`settings.hiddenModules`)
  - services: `customFieldService.js`, `teamSettingsService.js`, `authService.js` (`me`), `searchService.js`, `exportService.js` (layouts in the full export)
  - routes and validators: `routes/customFields.js`, `routes/organization.js`, `validators/customFields.js`
- **Frontend:**
  - scripts: `js/custom-fields.js` (sections in forms and Customer 360), `js/settings-fields.js` (Sections box, Section choice), `js/settings.js` (Pages block), `js/app.js` (hide switched-off pages)
  - pages and styles: `Settings.html`, `css/style.css`
  - texts: `i18n/en.json`, `i18n/hi.json` (only new keys; your uncommitted keys are left alone)
- **Docs:** `docs/BIZNUMA_ROADMAP.md` (D76)

No new npm packages, no `.env` changes, no data migration.

## 10. Acceptance checklist

- [ ] Owner and admin make, rename, reorder (↑ ↓), switch 1/2 columns and remove sections; agents and viewers get 403.
- [ ] Removing a section moves its fields to "More details", and no field is lost.
- [ ] Fields can be put in a section on add and on edit; an unknown section gets `INVALID_SECTION`.
- [ ] The customer, lead, deal and record forms and Customer 360 show sections in order, in 2 columns where chosen, and in 1 column on phones.
- [ ] Switching a page off hides it for everyone in the menu and in search; switching it on brings it back; Dashboard, Customers and Settings cannot be switched off.
- [ ] Another company cannot read or change the layout or the page settings.
- [ ] The full test suite has no new failures; every new text is in English and Hindi.
- [ ] Checked in the browser on desktop and at 390 px.

## 11. Scorecard targets (goals, not results)

1. **Setup speed:** put 6 existing fields into 2 sections (one with 2 columns) in 12 clicks or fewer, counted in the browser.
2. **Shorter forms:** a customer form with 10 custom fields in two 2-column sections is at least 30% shorter on a desktop screen than the same fields in one column, measured in the browser.
3. **Tidy menu:** switching off 3 unused pages takes 3 clicks (one switch each), and they disappear from the menu and search for every member (tests and browser).
4. **No regressions:** no new failures compared to the 1C commit, which passed 798 of 798 on its own.
5. **Mobile:** forms with sections at 390 px in one column, with no sideways scroll.

## 12. Decisions for you (defaults in bold)

1. **One layout per object for the whole company**, or different layouts per role now. Different layouts per role would pull part of 1E in.
2. Pages that are switched off **disappear from the menu and search, but a direct link still opens for members with access** (tidying, not security), or a switched-off page is blocked for everyone.
3. **Dashboard, Customers and Settings can never be switched off**, or only Settings is fixed.

## 13. Test baseline

The 1C commit `a1f5162`, run alone, gave **77 suites and 798 tests, all passed**. In the working folder, your uncommitted Hindi work brings back the known Sales Automation key failure, which does not come from this phase.

## 14. What was built, and how it differs from this spec

Built as specified, with these differences:

1. **Fields go into sections in the same save.** `PUT /custom-fields/layout` also takes an optional `fieldIds` list per section: exactly the active fields in that section from then on. A section sent without `fieldIds` keeps its fields. This lets Settings save names, columns, order and fields in one click.
2. **Archived fields keep their section while it exists.** `fieldIds` lists active fields only. When a section is removed, every field in it (archived ones too) goes to "More details" in the same transaction, so a field restored later comes back there, as section 8 says.
3. **How errors arrive.** An unknown section is `400 VALIDATION_ERROR` with `errors[].code = INVALID_SECTION`: on `sections` for the layout, on `sectionId` for a field. Section names are 1–40 characters, and a third column is refused.
4. **The Pages block has its own script,** `js/settings-pages.js`, instead of `js/settings.js`. Each switch saves at once, and quick clicks on several switches are saved one after another.
5. **The menu on the Settings page changes at once.** Other pages follow on their next load, from `/auth/me`, through the `crm_company` copy. No new browser storage key.
6. **First page after sign-in.** It skips switched-off pages when the member has another page they may open.
7. **Search with Leads off.** If a company switches off Leads but keeps Deals, leads are still found, and they open on the Deals page.
8. **Forms.** A long text field takes the whole row in a 2-column section. Up to 860 px wide (phones and small tablets), a 2-column section is one column, the same breakpoint as the forms' other 2-column rows. Section headings are drawn in the brand colour with a thin line, so they do not look like one more field label.
9. **Settings conveniences.**
   - After adding a field, the next field keeps the same Section choice.
   - A new section card scrolls into view.
   - Each field row shows a "Section: …" badge.
   - Unsaved section changes are marked "Changes not saved yet". They are dropped when you switch to another page's fields.
10. **One existing test changed on purpose.** `tests/phoneMasking.test.js` compares the whole `GET /organization/settings` answer, which now also has `hiddenModules: []`.

Changed files beyond section 9: `models/CustomFieldLayout.js`, `constants/customFields.js` (`MAX_SECTIONS`, `SECTION_LABEL_MAX`, `SECTION_ID_PATTERN`), `constants/permissions.js` (`ALWAYS_ON_MODULES`, `HIDEABLE_MODULES`), `js/customer-360.js` (headings in Overview), `js/settings-pages.js` (new).

## 15. Scorecard results (measured 2026-10-20)

Measured in the isolated preview: port 3100, an in-memory database and the tests' sign-in. The real database was not used.

| # | Target | Result |
|---|---|---|
| 1 | 6 fields into 2 sections (one with 2 columns) in ≤ 12 clicks | **10 clicks** from the Custom fields tab (11 counting the tab): Add section, 2 columns, 4 ticks, Add section, 2 ticks, Save sections. Typing the names is not counted. |
| 2 | ≥ 30% shorter form | **33% shorter.** 10 fields in two 2-column sections took 514 px in the New Customer form, against 770 px in one column (desktop, 1280 px window). |
| 3 | 3 pages off in 3 clicks, gone for every member | **3 clicks** (Marketing, Support, AI Insights). They left the owner's menu at once, and an agent's menu on the next page, though that agent has Marketing and Support access. The direct link to Marketing still opened. Tests check search for owners and agents. |
| 4 | No new failures | Full run in the working folder: **817 tests, 816 passed**, including the 16 new ones in `tests/fieldLayouts.test.js`. The one failure is the known Sales Automation text keys from the uncommitted Hindi work, not from 1D. An earlier full run also had two timing failures (Inbox live updates, broadcasts); both passed when run alone (17 of 17) and in the final run. |
| 5 | Mobile at 390 px | One column, no sideways scroll (page width 390 px). The Sections editor and the Pages switches fit too. |
