# Phase 5: Visual sales pipeline (spec)

Status: **approved with its defaults by the user's go-ahead of 2026-10-21**. The user said "start Phase 5" on 2026-10-22. This is Phase 5, "Visual Sales Pipeline" (inspired by Pipedrive), of `docs/CRM_10_FEATURE_IMPLEMENTATION_PROMPT.md`. **Built on 2026-10-22 (D84);** what was built and the scorecard are in sections 10 and 11. It is built in two parts:
- **5A:** the backend (pipelines, stage moves, history, board and summary).
- **5B:** the Deals board and the pipeline settings.

## 1. Goal

A small Indian business sells more than one thing. A distributor has "Dealer onboarding" and "Retail orders"; a contractor has "Site projects" and "Spare parts". The owner wants:

1. **Their own pipelines,** named their way, each with its own steps.
2. **One look at the board** for the count and value in every step, which deals are late, which have no next step, and which have gone quiet.
3. **Drag a deal to the next step.** If that fails, the card goes back and the reason is clear.
4. **A history of each deal's steps:** when it moved, who moved it, and how long it sat in each step.

## 2. What exists today (from the code)

- **A Lead is the deal.**
  - `Lead.stage` is one of six fixed values: New, Contacted, Quote Sent, Negotiation, Won, Lost.
  - Its probability comes from the stage. Lost needs a reason.
  - `version` gives optimistic locking: `POST /leads/:id/stage` and `PATCH` refuse a stale `version` with `409 VERSION_CONFLICT`.
- **The fixed stage is used everywhere:**
  - reports (won and lost, funnel) and AI Insights (win chance, D81);
  - attribution (D79), automation conditions and the "move stage" action;
  - quotations: sending one moves New or Contacted to Quote Sent;
  - Meta CAPI, outbound webhooks (`lead.stage_changed`), and the public API.
- **Stage changes** are written to `LeadActivity` ("Stage changed", `meta: { from, to }`) and the audit log. Nothing records how long a lead sat in a stage.
- **Deals.html / js/deals.js:**
  - a Kanban of the six stages (two shown by default, the others by a button) with the count and value per column;
  - drag and drop, and "Move to…" on phones.
  - A failed move shows a toast and reloads everything. There is no per-lead next activity and no "no next step" or "gone quiet" sign.
- **No pipelines.** Next activities exist as Tasks and Calendar events linked to a lead (`relatedType: 'Lead'`), plus `Lead.followUpAt`.

## 3. Zoho CRM benchmark (official pages, checked 2026-10-22)

Sources:
- [Zoho CRM – Multiple Sales Pipeline](https://help.zoho.com/portal/en/kb/crm/customize-crm-account/pipelines/articles/multiple-sales-pipeline)
- [Zoho CRM – FAQ: Multiple Sales Pipeline](https://help.zoho.com/portal/en/kb/crm/faqs/multiple-sales-pipeline/articles/faq-sales-pipeline)
- [Zoho CRM – Kanban View](https://help.zoho.com/portal/en/kb/crm/customize-crm-account/managing-module-views/articles/kanban-views)
- [Zoho CRM – Picklist History Tracking](https://help.zoho.com/portal/en/kb/crm/customize-crm-account/customizing-fields/articles/picklist-history)

What Zoho does well:
- **Pipelines:** multiple pipelines for Deals (Setup → Customization → Pipelines), with as many stages as needed.
  - Deleting a pipeline asks to move its open deals; closed ones stay.
- **Kanban:** drag a card to change the stage, and a column can show a summed value ("Aggregate by").
- **Stage history:** a Stage History list with a time stamp per change and the duration in each stage. Reports can find deals that stayed too long.

Where Zoho is limited:
- **Stuck deals are not flagged on the board.** Finding them needs a report on Stage History with a duration filter (the Zoho Analytics blog shows one).
- **The Kanban needs setup:** making a view ("Module Customization" permission), choosing "Aggregate by", and the pipeline dropdown appears only when grouped by stage.
- **Which edition has multiple pipelines is not stated** on the pages read (a community post says Standard and above: UNVERIFIED).

Where AgreemCRM Phase 5 will be better (each point can be checked):
- **The board shows by itself,** in every column: the count, the value, and the weighted value (by each stage's probability).
- **Each card shows:**
  - the **next activity** (the nearest open task, meeting or follow-up);
  - red for **overdue**;
  - amber for **no next step**;
  - grey for **gone quiet** (no activity for the stage's "quiet after N days").
- **One-drag moves with an instant board:** if the server refuses (someone else moved it, a stage of another pipeline, no lost reason), the card goes back to where it was and the toast says why and what to do.
- **The stage history** keeps the time in each stage, and it can never be edited.
- **Every plan** gets it.

Where it will **not** be better yet:
- **Stage rules** ("needs a quotation before Negotiation"), **custom fields per pipeline**, and **pipeline-wise reports** beyond the board's own totals.
- **Won and Lost** are shared by all pipelines (no custom closed stages).

## 4. Scope

### 5A (backend)

1. **Pipelines (`Pipeline`, per company):**
   - a name and 2–12 open stages, each with: a name, a **kind** (New, Contacted, Quote Sent or Negotiation: what the stage means to reports, automation and quotations), a probability (default from its kind) and "quiet after" days (default 7; 0 = off);
   - Won and Lost end every pipeline;
   - at most 10 pipelines per company.
   - Every company has a default **"Sales"** pipeline (New, Contacted, Quote Sent, Negotiation), made on first use.
   - The default pipeline cannot be deleted.
2. **Leads keep working as before:**
   - `Lead.stage` stays the fixed stage (the kind), so nothing that reads it changes;
   - new `pipelineId` and `pipelineStageId` say where the lead sits; a lead with no pipeline is in the default one;
   - when something else changes the fixed stage (a quotation sent, an automation, the API), the lead moves to the first stage of that kind in its pipeline.
3. **Moves:**
   - `POST /leads/:id/stage` also takes `pipelineStageId` (and `pipelineId` to move to another pipeline), with `version` as before;
   - a stage of another pipeline is refused (`400 STAGE_NOT_IN_PIPELINE`).
4. **Stage history (`LeadStageEvent`, immutable):**
   - each entry: from and to (stage id, name, kind), when, who, how (board, edit, quotation, automation, API, migration) and the **time spent in the stage it left**;
   - `GET /leads/:id/stage-history`.
5. **Board and summary:** `GET /pipelines/:id/board` gives the columns:
   - each with the count, value and weighted value;
   - the leads in it (at most 300 per column, newest activity first), each with its next activity and the flags `overdue`, `noNextStep` and `quiet`;
   - Won and Lost totals for the last 30 days.

   `GET /pipelines/:id/summary` gives the same totals without the cards.
6. **Changing pipelines:**
   - removing a stage or deleting a pipeline asks where its open leads go, and moves them with a history entry. Nothing is lost.
   - Only owners and admins change pipelines; everyone with the leads module reads them.
7. **Migration 007** puts every existing lead in the default pipeline, at the stage of its kind. It is idempotent.

### 5B (frontend)

1. **Deals board:**
   - a pipeline picker; columns for every stage of the chosen pipeline, plus Won and Lost drop zones;
   - column totals, and cards with the next activity and the flags;
   - drag and drop (and "Move to…" on phones) moves the card at once; on a refusal it goes back with an actionable toast;
   - the lead's box shows the stage history.
2. **Settings → Pipelines** (owners and admins): add, rename and reorder pipelines and stages; for each stage set its kind, probability and quiet days; delete with "move its leads to…".
3. **English and Hindi; phones at 390 px.**

## 5. Data model

```
Pipeline        organizationId, name (≤ 60), order, isDefault, deletedAt (soft delete)
                stages: [{ _id, name (≤ 40), kind: New|Contacted|Quote Sent|Negotiation,
                           probability 0–100, quietDays 0–365, order }]
                unique (organizationId, name) among the undeleted

Lead (+)        pipelineId, pipelineStageId, pipelineStageAt (when it entered that stage)

LeadStageEvent  organizationId, leadId, pipelineId,
                from { stageId, name, kind }, to { stageId, name, kind },
                at, memberId, actorName, source, msInFrom
                index (organizationId, leadId, at); updates and deletes are refused by the model
```

## 6. API

All are under `/api/v1`, with the usual auth, tenant scope and `{ success, data }` shape.

| Method, path | Who | What |
|---|---|---|
| `GET /pipelines` | leads module | pipelines with stages and open counts (the default is made if missing) |
| `POST /pipelines` | owners, admins | `{ name, stages: [{ name, kind, probability?, quietDays? }] }` |
| `GET /pipelines/:id` | leads module | one pipeline |
| `PATCH /pipelines/:id` | owners, admins | `{ name?, order?, stages?, moveStages?: { [removedStageId]: targetStageId } }` |
| `DELETE /pipelines/:id?moveTo=<pipelineId>` | owners, admins | moves its open leads, then deletes |
| `GET /pipelines/:id/board?ownerId&q` | leads module (own leads for agents who see only theirs) | columns, cards and flags |
| `GET /pipelines/:id/summary` | as board | totals only |
| `POST /leads/:id/stage` | as today | `+ pipelineStageId, pipelineId` |
| `GET /leads/:id/stage-history` | as the lead | the immutable entries, oldest first |

Errors:
- `STAGE_NOT_IN_PIPELINE` (400) and `VERSION_CONFLICT` (409, as today);
- `PIPELINE_IN_USE` (409, a delete without `moveTo` while it has open leads) and `MOVE_TARGET_REQUIRED` (400, a removed stage with leads and no target);
- `DEFAULT_PIPELINE` (409, deleting the default) and `LIMIT` (409, more than 10 pipelines).

## 7. Edge cases

- **Old leads:** a lead without a pipeline is in the default pipeline. One whose stage id no longer matches its kind shows at the first stage of its kind.
- **Won and Lost** keep the last open stage in `pipelineStageId`, so reopening goes back there.
- **A quotation, an automation or the API** changes the fixed stage: the lead moves within its own pipeline, and the history says how.
- **Two people move the same card:** the second gets `409 VERSION_CONFLICT`; the board puts the card back and reloads that column.
- **Deleted pipeline:** closed leads keep its id. History shows its name as it was then (names are copied into each entry).
- **Agents who see only their leads** see only their cards and totals.
- **Reports, AI Insights, attribution, automation, webhooks and the public API** are unchanged: they read the fixed stage.

## 8. Acceptance checklist

- [ ] Company A cannot read, change or move into company B's pipelines (test).
- [ ] A move to a stage of another pipeline is refused; a stale version is refused; a lost move without a reason is refused (test).
- [ ] Every move (board, edit, quotation sent, convert) writes exactly one history entry with the time in the previous stage; the model refuses updates and deletes (test).
- [ ] The board totals (count, value, weighted) and the flags (overdue, no next step, quiet) match the records (test).
- [ ] Removing a stage or deleting a pipeline moves its open leads, never drops them; the default cannot be deleted (test).
- [ ] Migration 007 places old leads by kind and is idempotent (test).
- [ ] The existing report, insights, automation and quotation tests stay green.
- [ ] Browser:
  - the board with two pipelines: drag a card (moves); a refused move (the card goes back, with the toast);
  - the history in the lead box;
  - Settings → Pipelines;
  - at 390 px, in English and Hindi.

## 9. Scorecard targets

| # | Target | How it is measured |
|---|---|---|
| 1 | Second pipeline ready in ≤ 6 clicks from Settings | Browser count |
| 2 | Board shows count, value, weighted value per column and 3 flags per card with 0 setup (Zoho: a Kanban view + Aggregate by; stuck deals need a report) | Browser + board test |
| 3 | A move is visible at once; a refused move restores the card and says why, every time | Browser (forced 409) |
| 4 | Stage history with time in stage for 100% of moves, immutable | Tests |
| 5 | 0 regressions (all existing tests green), 390 px, Hindi | Full test run + browser |

## 10. What was built (D84), and how it differs from this spec

5A and 5B were built on 2026-10-22 and are committed together as Phase 5. Built as specified, with these differences:

1. **A pipeline may skip a kind.** A lead whose fixed stage is not in its pipeline sits at the **last stage of an earlier kind**. For example, a quotation sent in a pipeline with no "Quote Sent" step keeps the lead at "Sample sent", while its fixed stage becomes Quote Sent for the reports. With no earlier stage, it sits at the first stage.
2. **The history keeps both:** the board step's name and the lead's fixed stage at that moment, which can differ (see 1).
3. **A kept stage given another kind** takes its leads' fixed stage along, recorded as a "pipeline" move.
4. **Agents** read pipelines and the board (their own leads only, when they see only their own). The Deals page's own filters (search, owner, value, close date, custom fields) narrow the board's cards, and the column totals follow what is shown.
5. **The old stage buttons** above the board (two stages shown by default) are replaced by the pipeline picker; every stage of the chosen pipeline is a column.
6. **Default stage names** ("New", "Contacted" …) are company data, so they show as written in Hindi too. The owner can rename them.

Files:
- **Backend:**
  - new: `constants/pipelines.js`, `models/Pipeline.js`, `models/LeadStageEvent.js`, `services/pipelineService.js`, `routes/pipelines.js`, `validators/pipelines.js`, `migrations/007-lead-pipelines.js`;
  - changed: `models/Lead.js`, `services/leadService.js` (board moves in `update`, history on every fixed-stage change, the pipeline on create, `stageHistory`), `services/quotationService.js`, `validators/crm.js`, `routes/leads.js`, `routes/index.js`, `migrations/index.js`, `services/exportService.js` (pipelines and the stage history are in "Download CRM data").
- **Frontend:** `js/deals.js` (the board), `Deals.html`, `css/deals.css`, `js/settings-pipelines.js` (new), `Settings.html`, `css/style.css`, and 55 texts (`pipe.*`, `pset.*`).
- **Tests:** `pipelines.test.js` (5).

## 11. Scorecard results (measured 2026-10-22)

Measured in the isolated preview (port 3100, an in-memory database, the tests' sign-in), with two pipelines and five deals.

| # | Target | Result |
|---|---|---|
| 1 | A second pipeline in ≤ 6 clicks | **Met: 3 clicks** (the Pipelines tab, "Add pipeline", Save) plus typing the name; the four usual stages come filled in. |
| 2 | Totals and 3 flags with 0 setup | **Met.** Each column showed its count, value and weighted value (e.g. "NEW (3) ₹2,05,000, weighted ₹20,500"). The cards showed "Follow-up 20 Oct, Overdue", "Send the price list · 23 Oct" (a task) and "No next step"; in the second pipeline, "Quiet 7 d" (the stage goes quiet after 5). The tests check the same numbers, and agents see only their own. |
| 3 | A move shows at once; a refused move puts the card back and says why | **Met.**<br>• Drag and drop and "Move to…" put the card in the new column before the server answered.<br>• With the deal changed behind the board's back, the card showed in Negotiation, came back to Contacted, and the toast said "Someone else changed this deal just now. The card went back and the board was refreshed; try again." |
| 4 | Stage history for every move, immutable | **Met.** Tests: create, board moves, a quotation sent, Won, reopening in another pipeline, a stage removed and a kind changed each write one entry with who, how and the time in the stage left; the model refuses to update, delete or re-save one. The deal box shows the history ("Enquiry → Sample sent · after under an hour"). |
| 5 | 0 regressions, 390 px, Hindi | **Met.** The existing lead, quotation, report, automation and API suites stayed green (23 suites, 112 tests, then the full run below). The board and Settings → Pipelines at 390 px had no sideways scroll (the board scrolls inside itself), in Hindi. |
