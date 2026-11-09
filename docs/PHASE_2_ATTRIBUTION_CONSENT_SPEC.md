# Phase 2: Where leads come from, and consent history (spec)

Status: **approved with its defaults by the user's go-ahead of 2026-10-21, and built the same day**. What was built and how it differs from this spec is in sections 13 and 14. This is Phase 2, "All-in-One Platform" (inspired by HubSpot), of `docs/CRM_10_FEATURE_IMPLEMENTATION_PROMPT.md`. It reuses leads, contacts, lead sources, the website form, campaigns, tickets and Customer 360.

## 1. Goal

An Indian SMB owner spends on Google, Facebook, IndiaMART and their website, and asks two questions every month:

1. **"Which ads and campaigns bring buyers, not only enquiries?"** Every enquiry should carry where it came from, campaign by campaign, and the report should show leads, wins and won value for each.
2. **"Can I prove a customer agreed to get offers, and that we stopped when they said STOP?"** Every consent change should be kept with who, how and when, and no marketing message should reach someone who opted out.

## 2. What exists today (from the code)

- **Lead sources.** Website form, IndiaMART, JustDial, TradeIndia, Facebook Lead Ads, Google Ads lead forms and the API all go through `leadIntakeService.intake`.
  - Each lead keeps one `source` (for example "Website") and a `sourceRef`.
  - An enquiry from a customer with an open lead is added to that lead ("attached").
  - **Nothing records the campaign, the UTM tags, the ad, the referrer or the landing page.**
- **The website form** (`publicFormService.embedScript`) posts the fields typed. It does not read the page's `utm_*` tags or `gclid`.
- **Reports → Lead sources** (`reportService.sources`) counts enquiries and leads per source, with a funnel. There is nothing per campaign and no won value.
- **Consent.**
  - `Contact.consent` keeps only the current state (`unknown / opted_in / opted_out`), when it changed and how.
  - It is changed by the customer form, STOP/START replies, the CSV import and the API, but **earlier changes are overwritten**.
  - Opt-outs are already enforced on broadcasts, workflow marketing templates (and sequences, which run through them), auto-replies and the API's template send.
- **Customer 360** shows deals, tasks, tickets, documents and notes on its timeline. It shows nothing about where the customer came from or their consent history.

## 3. Zoho CRM benchmark (official pages, checked 2026-10-21)

Sources:
- [Zoho CRM – Track and report on UTM details of leads](https://www.zoho.com/crm/resources/solutions/track-and-report-on-utm-details-of-leads.html)
- [Zoho Forms – UTM Tracking Overview](https://help.zoho.com/portal/en/kb/forms/tracking-in-zoho-forms/utm-tracking/articles/utm-overview)

What Zoho does well:
- **Zoho Forms** (a separate product) can capture UTM tags and `gclid`. In "Advanced Tracking" it guesses the source from search engines and referrers. Its integration can push those values into CRM fields.
- **Campaigns** in Zoho CRM can be linked to leads, with campaign hierarchies.

Where Zoho is limited:
- The Zoho CRM solution page says: "Presently, it's not possible to track UTM details inside a lead record in your CRM."
- Its workaround needs **six custom fields, a workflow rule and a Deluge function**, rated "High" complexity, for **"Enterprise and above"**.
- UTM capture on forms needs Zoho Forms, a second product.

Where AgreemCRM Phase 2 will be better (each point can be checked):
- **Zero setup:** the CRM's own website form captures the UTM tags, `gclid`/`fbclid`, the referrer and the landing page.
- **Ad details from lead sources:** Facebook Lead Ads and Google Ads leads record their ad, form or campaign by themselves.
- **Every plan** gets it, the trial too.
- **First and last touch are both kept**, and they survive repeat enquiries. The report shows **won value** per channel and campaign.
- **A consent history** with who, how and when, shown on Customer 360.

Where it will **not** be better yet:
- No multi-touch weighting models (linear, U-shaped).
- No landing page builder, and no email campaigns (no email provider is chosen yet).
- No click-to-WhatsApp ad referrals; those are in the "Last 5%" plan.

## 4. Scope

In Phase 2:

1. **Touchpoints.** Every enquiry that reaches `intake` records a `Touchpoint`:
   - **channel** (Paid search, Paid social, Organic search, Social, Referral, Direct, Marketplace, WhatsApp, Other) and the source;
   - **UTM** tags (source, medium, campaign, term, content), and the `gclid` / `fbclid`;
   - the **referrer** and the **landing page**;
   - for Facebook, the ad id and form name; for Google Ads, the campaign id.
2. **First and last touch.**
   - A new lead keeps its first touch and its last touch.
   - A repeat enquiry that attaches to an open lead adds a touchpoint and updates only the **last** touch.
   - A customer keeps their **first touch** forever, whatever comes later.
3. **The website form** reads the page's `utm_*`, `gclid`, `fbclid`, the referrer and the landing page.
   - The visitor's **first** campaign tags are kept for 30 days in that website's own browser storage, so a visitor who came from an ad and filled the form two pages later still counts.
   - No personal data is kept there; only the campaign tags and the time.
4. **The public API's `POST /leads`** also takes `utm`, `referrer` and `landingPage`.
5. **Reports → Where leads come from:** leads, won count, won value and conversion, by **channel** or by **campaign**, for **first** or **last** touch, for a date range. Owners, admins and members with the Reports module can see it; members who only see their own leads see their own.
6. **Consent history.** Every change of a customer's WhatsApp marketing consent is kept as a `ConsentEvent`:
   - from what to what, how (customer form, STOP/START reply, import, API, website form) and when;
   - who did it, or "the customer".
7. **Website form consent box** (off by default): "Send me offers on WhatsApp". A ticked box opts the customer in, recording the form and the page.
8. **Customer 360** shows "How they found you" (first touch and every touchpoint) and the consent history.
9. **Opt-out stays enforced** on every marketing path; tests check broadcasts, workflow templates, auto-replies and the API.
10. **English and Hindi** for every new screen text; phones at 390 px.

Not in Phase 2: multi-touch weighting; landing pages; email campaigns; click-to-WhatsApp ad referral; backfilling old leads (they show their source only).

## 5. Data model (all additive, no migration)

- **`Touchpoint`** (new):

  | Field | Meaning |
  |---|---|
  | `organizationId`, `contactId`, `leadId` | whose touch |
  | `intakeId` | the enquiry it came with |
  | `source` | a `LEAD_SOURCES` value |
  | `channel` | one of the channels in section 4 |
  | `utm` | `{ source, medium, campaign, term, content }` |
  | `clickIds` | `{ gclid, fbclid }` |
  | `referrer`, `landingPage` | up to 500 characters each |
  | `ad` | `{ id, name, formName, campaignId }` |
  | `at` | when |

  Indexed by company + contact and company + time.
- **`Lead.attribution`**: `{ first, last }`, each `{ channel, source, campaign, medium, at }`, set at creation; `last` is updated on attach.
- **`Contact.firstTouch`**: the same shape, set once.
- **`ConsentEvent`** (new):

  | Field | Meaning |
  |---|---|
  | `organizationId`, `contactId` | whose consent |
  | `channel` | `whatsapp` |
  | `from`, `to` | the states before and after |
  | `method` | `manual`, `whatsapp_reply`, `import`, `api`, `website_form` |
  | `memberId`, `actorName` | who |
  | `detail` | for example the form's page |
  | `at` | when |
- **Website form settings**: `askFor.consent` (default false) and `consentText`.

## 6. API

| Method and path | Who | What |
|---|---|---|
| `GET /reports/attribution?from&to&by=channel\|campaign&touch=first\|last` | Reports module | `{ items: [{ key, channel, leads, won, wonValuePaise, conversionPct }], totals }` |
| `GET /contacts/:id/touchpoints` | who can see the customer | the customer's first touch and touchpoints, newest first |
| `GET /contacts/:id/consent-history` | who can see the customer | the consent events, newest first |
| `POST /public/forms/:key` (exists) | the website | also `utm_source`…`utm_content`, `gclid`, `fbclid`, `referrer`, `landingPage`, `consent` |
| `POST /api/public/v1/leads` (exists) | API key `leads:write` | also `utm`, `referrer`, `landingPage` |
| leads and contacts (exist) | as today | also `attribution` (leads) and `firstTouch` (contacts) |

The full export adds `touchpoints` and `consentEvents`. Every query is scoped to the company.

## 7. Screens

- **Reports → Leads tab:** a new card, "Where leads come from":
  - a switch for Channel / Campaign and one for First / Last touch;
  - a table of channel or campaign, leads, won, won value and conversion %;
  - on phones the table becomes cards.
- **Customer 360 → Overview:** "How they found you" (for example "Paid search · google / cpc · diwali_sale · 12 Oct") and a "Consent history" list (for example "Opted out · replied STOP · 14 Oct").
- **Settings → Lead sources → website form:** "Ask for consent to WhatsApp offers" with the checkbox text.

## 8. Edge cases

- **The same click twice** (a double submit) is one enquiry, as today, so it makes one touchpoint.
- **Junk tags:** tags longer than 200 characters are cut; unknown tags are ignored; URLs are kept without fragments.
- **No tags at all:**
  - with a referrer, the channel comes from the referrer (Google → Organic search, Facebook → Social, others → Referral);
  - with no referrer, it is Direct;
  - a marketplace source is Marketplace;
  - WhatsApp is WhatsApp; manual, import and API are Other.
- **A private number (D61)** keeps its touchpoints private like its leads.
- **Members** see touchpoints only of customers they can see.
- **Consent:**
  - a consent "change" to the same state is not recorded;
  - an import only records an event when it actually opts someone in, as today.

## 9. Files

New:
- **Backend:**
  - models: `Touchpoint.js`, `ConsentEvent.js`
  - services: `attributionService.js`, `consentService.js`
  - tests: `attribution.test.js`, `consentHistory.test.js`

Changed:
- **Backend:**
  - constants: `crm.js` (channels)
  - models: `Lead.js`, `Contact.js`
  - lead intake: `leadIntakeService.js`, `publicFormService.js`, `leadSourceService.js`, `leadWebhookService.js`, `integrations/leadSources/facebook.js`, `googleAds.js`
  - API: `publicApiService.js`
  - reports: `reportService.js`, `routes/reports.js`, `validators/reports.js`
  - consent: `contactService.js`, `automation/consent.js`, `contactImportService.js`
  - contacts: `routes/contacts.js`
  - validators: `validators/leadSources.js`, `validators/integrations.js`
  - `exportService.js`
- **Frontend:**
  - `Reports & Analytics.html`, `js/reports.js`
  - `js/customer-360.js`
  - `js/settings-leadsources.js`
  - `css/style.css`
  - `i18n/en.json`, `i18n/hi.json` (new keys only; the user's uncommitted keys are left alone)
- **Docs:** `docs/BIZNUMA_ROADMAP.md` (D79), `docs/INTEGRATIONS.md`

The user's uncommitted Marketing and Sales Automation files are not touched. No new npm packages, no `.env` changes, no migration.

## 10. Acceptance checklist

- [ ] A website enquiry from a tagged link records its channel, tags, referrer and landing page, and the lead and customer show them.
- [ ] Facebook and Google Ads leads record their ad, form or campaign.
- [ ] A repeat enquiry from another campaign keeps the first touch and updates the last; the customer's first touch never changes.
- [ ] The attribution report's numbers (leads, won, won value) match the data for first and last touch, by channel and by campaign. Members who only see their own leads see their own.
- [ ] Every consent change is recorded with method and actor; same-state saves are not.
- [ ] Opted-out customers get no broadcast, workflow marketing template, auto-reply template or API template.
- [ ] The website form's honeypot, origin check and rate limits still work.
- [ ] Another company never sees any of it.
- [ ] The full test suite has no new failures; every new text is in English and Hindi; checked in the browser on desktop and at 390 px.

## 11. Scorecard targets

1. **Zero setup:** a tagged website enquiry shows its campaign on the lead and Customer 360 with **0** custom fields or workflows. Zoho needs 6 fields, a workflow and a function, on Enterprise.
2. **Survives repeats:** first touch kept and last touch updated on an attached enquiry (tests).
3. **Report:** leads, won and won value by channel and campaign, first or last touch, matching the test data **exactly**.
4. **Consent:** **100%** of changes recorded with method; **0** marketing messages to opted-out customers on the 4 paths (tests).
5. **No regressions; mobile at 390 px.**

## 12. Decisions (defaults taken under the go-ahead)

1. **Both first and last touch kept; the report shows first touch by default.**
2. **The website form remembers a visitor's first campaign tags for 30 days** in that website's own browser storage, or it reads only the page with the form.
3. **The website form's consent box is off until the company switches it on.**

## 13. What was built, and how it differs from this spec

Built as specified, with these differences:

1. **The website form answers `201 Created`,** as it did before; nothing about it changed.
2. **The report on phones** uses the Reports page's existing table style, which already turns rows into cards at phone width.
3. **The channel names** on screen: "Other websites" for `referral` and "Direct" for `direct`, so owners do not need marketing words.
4. **A retried enquiry** whose lead was already made does not add a second touchpoint. A double click is still one enquiry and one touchpoint.
5. **The API's consent changes** are now recorded with method `api` (they were saved as "manual" before), and so is `Contact.consent.method`.
6. **The opt-out paths tested:**
   - new tests: the workflow marketing template (and so sequences, which run through it) and the API's template send;
   - existing tests: broadcasts (`broadcasts.test.js`, `marketing.test.js`);
   - auto-replies use the same check in code (`autoReplyService`), without a new test of their own.
7. **Customer 360** shows up to 10 touchpoints and 10 consent changes; the full lists are in the API.

The user's uncommitted Marketing, Sales Automation and other files were not touched.

## 14. Scorecard results (measured 2026-10-21)

Measured in the isolated preview (port 3100, an in-memory database, the tests' sign-in).

| # | Target | Result |
|---|---|---|
| 1 | A tagged enquiry shows its campaign with 0 setup | **Met.** Three website enquiries (Google cpc "diwali_sale", Instagram paid "reels_oct", a Bing search) showed Paid search, Paid social and Organic search on the leads, Reports and Customer 360. No field or workflow was made. |
| 2 | First touch survives repeats | **Met.** A second enquiry from the "navratri" Facebook campaign attached to the open lead: first touch stayed "diwali_sale", last became "navratri", and the customer's first touch stayed (tests and browser). |
| 3 | Report numbers exact | **Met.** By channel, first touch: Paid search 1 lead, 1 won, ₹1,18,000, 100%; totals 3 leads, 1 won, 33.3%. By campaign and last touch the win moves to "navratri". The tests check the same numbers. |
| 4 | Consent recorded; no marketing to opt-outs | **Met for 4 of 4 change methods, plus the website form** (manual, WhatsApp reply, import, API, website form). The opt-out paths are as in section 13, point 6. |
| 5 | No regressions; mobile at 390 px | **Met.** Full run: **881 tests, 880 passed**, including 19 new ones (`attribution.test.js` 10, `consentHistory.test.js` 9); the one failure is the known Sales Automation text keys. Reports, Customer 360 and Settings → Lead sources at 390 px had no sideways scroll. |
