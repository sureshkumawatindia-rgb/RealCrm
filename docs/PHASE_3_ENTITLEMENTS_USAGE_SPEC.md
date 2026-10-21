# Phase 3: Plan entitlements and usage meters (spec)

Status: **approved with its defaults by the user's go-ahead of 2026-10-21** (questions and defaults are pre-approved up to Phase 10). **Phase 3A was built the same day (D80);** what was built and the scorecard are in sections 13 and 14. This is Phase 3, "Value for Money" (inspired by Zoho), of `docs/CRM_10_FEATURE_IMPLEMENTATION_PROMPT.md`. Its build order says: **first only entitlements and usage meters, limits later**. So this spec is **Phase 3A**. Phase 3B (race-safe limits, and an explainable win probability with an "insufficient data" answer) follows in section 12 and is built after 3A.

## 1. Goal

An Indian SMB owner pays for a plan and asks three things:

1. **"What am I using, and what does my plan give me?"** Everything that is counted should be on one screen, not in three corners of Settings.
2. **"Warn me before I hit the wall."** The owner should hear about 80% and 100% before a salesperson is stopped in front of a customer.
3. **"Is it growing?"** Usage over the last 30 days, and when a limit will be reached at this pace.

And the platform owner (who sells the CRM) asks: **"Can I give one customer a little more, for a while, without changing their plan?"**

## 2. What exists today (from the code)

- **Plans as data.**
  - `constants/plans.js` has 5 plans (Starter, Pro, Growth, Scale, Infinite).
  - Each plan has 7 limits (users, agents, WhatsApp numbers, contacts, broadcasts a month, quotations a month, templates) and 6 features (payment links, Meta CAPI, catalog, agent numbers, automation workflows, API and webhooks).
  - Prices are D69; **this phase changes no price and no number.**
- **The server enforces them.**
  - `planService.assertRoom` / `assertFeature` / `assertActive` are called by 14 services (contacts, import, invites, members, quotations, templates, WhatsApp numbers, API keys, webhooks, workflows, catalog, CAPI, payment links, AI).
  - A locked subscription (trial over, payment failed) stops adding, never reading or replying.
- **Usage meters.**
  - `planService.usageOf` counts the 7 limits live from the records.
  - Settings → Plan & usage (owners and admins) shows them as bars.
  - **There is no history, no alert before the limit, and nothing else is counted:** API calls, webhook sends, workflow runs, files, custom fields and objects are not counted anywhere.
- **The AI budget.**
  - `aiService` keeps `AiUsage` rows and stops at the plan's share of `AI_MONTHLY_BUDGET_USD`.
  - It is shown only in Settings → AI, not with the other meters.
- **The platform owner's command** `backend/scripts/plan.js` can list companies, comp one, give a longer trial or set a plan. **It cannot give extra allowances.**
- **Members who are not owners or admins** see a "See plans" prompt only after the server refuses something. Nothing tells them beforehand that, for example, the API needs the Growth plan.

## 3. Zoho CRM benchmark (official pages, checked 2026-10-21)

Sources:
- [Zoho CRM API – Limits (v8)](https://www.zoho.com/crm/developer/docs/api/v8/api-limits.html)
- [Zoho CRM – Specifications](https://help.zoho.com/portal/en/kb/crm/crm-reference/introduction-to-zoho-crm/articles/specifications-zoho-crm)
- [Zoho CRM – Manage Data Storage Space](https://help.zoho.com/portal/en/kb/crm/manage-crm-data/storage-space/articles/manage-data-storage)
- [Zoho CRM – Feature-wise comparison of editions](https://www.zoho.com/crm/complete-feature-list.html)

What Zoho does well:
- **Detailed limits per edition:** custom modules, custom fields per module, API credits per 24 hours (a base plus a per-user amount, with a cap per edition).
- **An API dashboard** (Setup → Developer Space → APIs) shows credits by application and function. An admin can raise the credit limit there, billed pay-as-you-go.
- **A Storage page** (Setup → Data Administration → Storage) shows allocated, used and remaining data storage, space by module, and the top 25 users per module. It also shows what deleting the recycle bin, junk and untouched records would free.
- **Add-ons** (extra storage, API credits) can be bought when a limit is hit.

Where Zoho is limited:
- **Usage is spread over several places:** storage, the API dashboard and the edition limits are separate pages.
- **No history or trend:** the storage page describes current usage only, "calculated periodically".
- **Alerts are vague:** Zoho says it will "inform you" near the limit, without saying when or how (UNVERIFIED in detail: the page gives no method or timing).
- **Credits are a technical unit** (1 to 500 credits per call type) that an SMB owner cannot easily reason about.

Where YELLOW CRM Phase 3A will be better (each point can be checked):
- **One screen** with every meter: the 7 plan limits, the AI budget, and 6 counted meters (API calls, webhook sends, workflow runs, files, custom fields, custom objects), in plain units.
- **Alerts at 80% and 100%**, by bell (and web push where switched on), to owners and admins, once per level per period, within an hour.
- **30 days of history** for every meter, and **"full around <date>"** at the current pace. Daily snapshots are kept 400 days.
- **Extra allowances for one company** (e.g. +5,000 contacts for 30 days, or the API on Pro for a pilot). They apply to every server check at once, end on their date by themselves and are written to the audit log.
- **Every member sees the plan a feature needs before clicking** (on Settings → Connections). The server still refuses on its own.

Where it will **not** be better yet:
- **No add-on purchase:** extra allowances are given by the platform owner with a command. Selling add-ons needs prices, which this phase does not invent.
- **No storage page** with clean-up suggestions (recycle bin, untouched records).
- **No per-user breakdown** (Zoho's "top 25 users").
- **New meters are counted, not limited.** Deciding limits for them is a pricing decision, left for later.

## 4. Scope (Phase 3A)

1. **Six counted meters**, shown with no limit ("Counted, not limited"):
   - **API calls this month:** every authenticated public API request; a new atomic counter.
   - **Webhook sends this month:** `WebhookDelivery` rows.
   - **Workflow runs this month:** `AutomationRun` rows.
   - **Files:** total size of the files in Documents.
   - **Custom fields** and **custom objects:** active definitions.
2. **The AI budget joins the meters**, as a percentage of this month's budget. It is already enforced; nothing changes there.
3. **Extra allowances (grants)** per company:
   - a limit + N, or a feature switched on;
   - optional end date and a reason;
   - made with `scripts/plan.js grant|grants|revoke`;
   - written to the audit log.
   - The effective plan (plan + active grants) is what every server check uses.
4. **`GET /billing/entitlements`** for every member: features (on or off, why, the cheapest plan that has it) and limits (with extras). No usage numbers for non-managers.
5. **Daily usage snapshots** (`UsageSnapshot`, one per company per India day, kept 400 days) and **`GET /billing/usage/history`** (owners and admins).
6. **Usage alerts** at 80% and 100% for every limited meter (the 7 limits and the AI budget):
   - bell (and web push) to active owners and admins, linking to Plan & usage;
   - once per level per period: a month for monthly meters, otherwise until usage falls below 80% again.
7. **Settings → Plan & usage:**
   - meters in two groups ("Your plan's limits", "Counted, not limited");
   - each meter with a 30-day sparkline, the change in 30 days, and "full around <date>" when a limit will be reached in the next 90 days at this pace;
   - extras shown as "includes 5,000 extra until 30 Nov".
8. **Settings → Connections:** a row whose feature the plan lacks says "Comes with the Growth plan" for every member who can open it.
9. **English and Hindi** for every new screen text; phones at 390 px.

Not in 3A: new limits, add-on purchase, prices, a storage clean-up page, per-user breakdown, race-safe reservation (3B), win probability (3B).

## 5. Data model

### 5.1 `Organization.entitlementGrants[]` (new, embedded)

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | to revoke one |
| `key` | String | a limit (`contacts` …) or a feature (`api` …) from `constants/plans.js` |
| `extra` | Number ≥ 1 | for a limit: how many more. Absent for a feature (it switches it on). |
| `until` | Date | optional; the grant ends by itself at this moment |
| `reason` | String ≤ 200 | for the platform owner and the audit log; not shown to the customer |
| `by` | String ≤ 100 | who gave it (the command's `--by`, default "platform") |
| `at` | Date | when |

Rules:
- Several grants on one key add up.
- A grant on a plan with no limit for that key changes nothing (unlimited stays unlimited).
- Expired grants stay in the list for history; they are not applied.

### 5.2 `Organization.usageSnapshotOn` (String, YYYY-MM-DD) and `Organization.usageAlerts` (Mixed)

- `usageSnapshotOn` claims the day, like `teamSummarySentOn`.
- `usageAlerts[metric] = { level: 80 | 100, period: '2026-10' | 'always' }` is the last alert sent.

### 5.3 `UsageSnapshot` (new collection)

```
organizationId  ObjectId, required
day             String YYYY-MM-DD (India), required
plan            String (plan key that day)
meters          [{ metric, used, limit (null = none) }]
expireAt        Date (day + 400 days), TTL index
unique (organizationId, day)
```

- Written once a day by the job and never edited.
- It records what was counted that day, so a later dispute can be checked.

### 5.4 `UsageCounter` (new collection)

```
organizationId  ObjectId, required
metric          String ('apiCalls')
period          String 'YYYY-MM' (India month)
count           Number
expireAt        Date (end of period + 400 days), TTL index
unique (organizationId, metric, period)
```

- Incremented with one atomic `$inc` upsert per request, so concurrent calls are never lost.
- A failed increment is logged and never fails the API call.

### 5.5 `constants/plans.js`

- `LIMITS` stays as it is.
- New `METERS` (the counted ones): `{ apiCallsPerMonth, webhookSendsPerMonth, workflowRunsPerMonth, fileBytes, customFields, customObjects }`, each with a label, unit (`count` | `bytes`) and `monthly`.
- `ALERT_LEVELS = [80, 100]`.

## 6. API

All under `/api/v1`, with the existing auth, tenant scope and `{ success: true, data }` shape.

| Method, path | Who | Returns |
|---|---|---|
| `GET /billing/entitlements` | every member | `{ plan: {key, name}, locked, features: [{ key, label, on, from: 'plan'\|'grant'\|null, until, needs: {key, name}\|null }], limits: [{ metric, label, limit, extra, until }] }` |
| `GET /billing/subscription` | every member (as now) | as now; for owners and admins, `usage` gains the AI budget and the 6 counted meters (`{ metric, label, used, limit, left, monthly, unit, group: 'limit'\|'counted', extra, until }`) |
| `GET /billing/usage/history?days=30` | owners and admins | `{ from, to, meters: [{ metric, label, unit, points: [{ day, used, limit }] }] }`; `days` 7–400, default 30 |

- `GET /billing/plans` (public price list) is unchanged.
- Errors: `days` out of range → 400 `VALIDATION_ERROR`; non-managers on history → 403 `FORBIDDEN`.

## 7. Jobs

`billing.usage` runs every hour. For each company:

1. **Snapshot:**
   - if `usageSnapshotOn` ≠ today, claim the day (atomic update on that field);
   - compute every meter and upsert today's `UsageSnapshot`.
2. **Alerts:** for each limited meter with a limit:
   - level = 100 if used ≥ limit, 80 if used ≥ 80% of the limit, else none;
   - period = this month for monthly meters, `always` otherwise;
   - if the level is higher than the stored one for this period, claim it atomically (only one worker wins), then tell owners and admins;
   - if a non-monthly meter falls below 80%, clear its stored level, so a later rise alerts again.

Notes:
- Companies are processed in batches of 200, oldest first; a failure in one company is logged and the job goes on.
- A company set to be deleted is skipped.

## 8. UI

### Settings → Plan & usage (owners and admins)

- **"Your plan's limits":** the 7 limits and the AI budget. Each card shows:
  - used / limit and a bar (green, amber at 80%, red at 100%), as now;
  - **extra:** "Includes 5,000 extra until 30 Nov";
  - **sparkline:** 30 days of snapshots plus today's live number, an inline SVG with a text alternative;
  - **trend:** "+312 in 30 days" or "No change in 30 days";
  - **forecast:** "Full around 12 Dec at this pace". This shows only when the limit is reached within 90 days. For monthly meters it uses this month's pace ("Used up around 25 Oct").
- **"Counted, not limited":** the 6 counted meters (files in KB/MB/GB) with sparkline and trend.
- If history is not there yet (a new company, or the job has not run today): "History starts tomorrow".

### Settings → Connections (owners and admins, as now)

- A row whose feature the plan lacks gets a "Growth plan" badge and the line "Comes with the Growth plan and above".
- Its Set up button still opens the tab, which explains the rest. The server still refuses.

### Bell notes

- "Contacts: 80% of your plan used". Body: "4,812 of 6,000 contacts on the Starter plan. See Plan & usage to upgrade, or archive what you no longer need." Link: `Settings.html?tab=plan`.
- At 100%: "Contacts: your plan's limit is reached". Body: "6,000 of 6,000. New contacts from WhatsApp and lead sources still come in; adding them by hand or import stops until you upgrade."
- Monthly meters: "…this month's 2,000 quotations are used up; they start again on 1 Nov."

## 9. Edge cases

- **Plan with no limit (Infinite):** no bar, no alerts, no forecast; the history still shows.
- **Downgrade below current usage:** the meter shows over 100% (e.g. 7,000 / 6,000), the alert says the limit is reached, and nothing is deleted.
- **Grant expiry mid-month:** the next check uses the plan's number; nothing is deleted. The meter shows the lower limit and the alert logic applies again.
- **Two grants on one key** add up; a revoked grant is removed and audited.
- **Locked subscription:** entitlements say `locked: true`, and every feature shows `on: false` with the lock reason.
- **Timezone:** days and months are India time (as the existing monthly limits).
- **Many requests:** the API counter uses `$inc`; the job claims days and levels atomically, so a second worker or a retry never sends a second alert.
- **Deleted records:** contacts and files count live (not deleted) records, as now. Quotations this month keep counting deleted ones (as now, D69).
- **Non-managers** get entitlements but never usage numbers.

## 10. Acceptance checklist

- [ ] Entitlements and usage are tenant-scoped: company B never sees A's numbers, grants or history (test).
- [ ] A grant raises the limit on the real server check (`assertRoom`) and switches on a feature (`assertFeature`). An expired grant does not (test).
- [ ] Grant and revoke write audit entries (test).
- [ ] The API counter counts concurrent calls exactly (20 parallel calls → 20) (test).
- [ ] The job makes one snapshot per company per day, even when run twice or by two workers (test).
- [ ] Alerts: 80% sends one note to owners and admins, a second run sends none, 100% sends one more, and the next month alerts again for a monthly meter (test).
- [ ] History returns 30 points in order, and only to owners and admins (test).
- [ ] No client-only gate: every feature is still refused by the API without the UI (existing tests stay green; one new test calls the API directly with a grant expired).
- [ ] The Plan & usage page shows both groups, sparklines, trend and forecast. Connections shows the plan badge. Checked at desktop and 390 px; English and Hindi.

## 11. Scorecard targets

| # | Target | How it is measured |
|---|---|---|
| 1 | Every meter on one screen: 14 meters (7 limits + AI budget + 6 counted), 1 click from Settings | Browser check; Zoho needs 3 pages (storage, API dashboard, edition limits) |
| 2 | Warning before the wall: a note at 80% and 100%, once each, within 1 hour | Job runs hourly; tests prove once-only |
| 3 | 30-day history and a "full around" date for every limited meter | Browser check with seeded snapshots |
| 4 | A grant applies to every server check at once and ends by itself | Tests on `assertRoom` / `assertFeature` |
| 5 | 0 client-only gates, and 390 px with no sideways scroll | Tests call the API directly; browser at 390 px |

## 12. Phase 3B (after 3A is built and committed)

1. **Race-safe limits.**
   - Today `assertRoom` counts and then the record is added. Two requests at the same moment can both pass and go one over.
   - 3B makes the counted adds (contacts, quotations, templates, invites) reserve a seat atomically (a per-company counter with a conditional `$inc`, released on failure) or re-check inside the transaction.
   - Tests fire parallel requests at the limit.
2. **Explainable win probability.**
   - `GET /reports/insights` gives each open lead its stage's fixed probability.
   - 3B adds a win probability learned from the company's own closed leads (by stage, source and value band), with the facts it used ("12 of 30 similar leads were won").
   - It answers **"insufficient data"** when fewer than 20 closed leads are similar.
   - Plus a next step from the lead's facts (no follow-up for 7 days, quotation not opened …).
   - Deterministic: no AI vendor and no customer data sent out.

## 13. What was built (3A), and how it differs from this spec

Built as specified (D80), with these differences:

1. **The AI budget meter shows only where the platform has set up AI** (a Claude key), because without one there is no budget to show. The preview had none; a test with a fake AI client checks the meter and its 80% note.
2. **Settings → Connections stays for owners and admins** (as in 1F). The plan badge reaches everyone who can open it. Every member gets the same facts from `GET /billing/entitlements`.
3. **Monthly meters show no "in 30 days" change,** because they start again on the 1st. They show "Used up around <date> at this pace" when that falls in this month.
4. **A locked company gets no usage notes:** its banner already says that adding has stopped.
5. **Webhook sends:** deliveries are kept 30 days, so on the 31st of a month the sends of the 1st may no longer be counted.
6. **The bell notes are in English,** like the other plan and billing notes the server writes. The screens are in English and Hindi.
7. **`scripts/plan.js grants`** lists grants in force and ended ones. `revoke` removes one. Both write the audit log (`entitlement.granted`, `entitlement.revoked`).

Files:
- **Backend:**
  - `constants/plans.js` (`METERS`, `ALERT_LEVELS`);
  - new models `UsageSnapshot` and `UsageCounter`; Organization `entitlementGrants`, `usageSnapshotOn` and `usageAlerts`;
  - `planService` (grants, `effectivePlanOf`, `entitlements`); new services `usageService` and `usageCounterService`;
  - `middleware/apiKey.js` (counts calls), `integrationStatusService` (plan notes), `routes/billing.js` with `validators/billing.js`, `jobs/index.js`, `aiService` (`budgetMicros` exported), `scripts/plan.js`.
- **Frontend:** `js/settings-plan.js`, `js/settings-connections.js`, `Settings.html`, `css/style.css`, and 32 texts (`usage.*`, `conn.plan.*`).
- **Tests:** `tests/usage.test.js` (7).

## 14. Scorecard results (measured 2026-10-21)

Measured in the isolated preview (port 3100, an in-memory database, the tests' sign-in). The test company was a Starter company with 5,000 contacts, 85 templates, 1,600 quotations this month, 37 API calls, 12 MB of files and 29 days of history. A +2,000 contacts grant was made with `scripts/plan.js` against that in-memory database.

| # | Target | Result |
|---|---|---|
| 1 | Every meter on one screen, 1 click from Settings | **Met.** Plan & usage showed 13 meters in two groups: 7 limits, plus 6 counted ones (API calls 37, webhook sends, workflow runs, files 12 MB, custom fields, custom objects). The AI budget is the 14th where AI is set up (tested). Zoho spreads these over 3 pages. |
| 2 | A note at 80% and 100%, once each, within an hour | **Met.** The hourly job sent "Message templates: 80% of your plan used" and "Quotations this month: 80% of your plan used" to the owner, not the agent. In tests: two runs at once send one note per level, 100% sends one more, a fall below 80% re-arms it, and a new month re-arms monthly meters. |
| 3 | 30-day history and "full around" | **Met.** Contacts: "Includes 2,000 extra until 20 Nov 2026", "+1,740 in the last 29 days", "Full around 10 Dec at this pace". Templates: "Full around 8 Nov". Quotations: "Used up around 27 Oct". Each meter has a sparkline with a text alternative. |
| 4 | A grant applies everywhere at once and ends by itself | **Met.** Tests: +5 templates passes `assertRoom` for 5 and refuses 6 with "The Starter plan with its 5 extra allows 105 …". A workflow grant lets `POST /workflows` through (201). An ended grant and a revoked one are refused again. Both are in the audit log. |
| 5 | 0 client-only gates; 390 px | **Met.** The tests call the API directly, with no screen, and the server refuses. Plan & usage and Connections at 390 px: no sideways scroll (390/390). Checked in Hindi. |

Full test run: **888 tests, 885 passed**, including the 7 new ones. The failures:
- the known Sales Automation text keys (the user's uncommitted work);
- the two WhatsApp acceptance tests that wait on timing under load. They passed when run alone (3 of 3).
