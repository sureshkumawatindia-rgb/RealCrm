# Phase 7: A visual workflow builder, boards, and @mentions (spec)

Status: **approved with its defaults by the user's go-ahead of 2026-10-21** (all questions and defaults through Phase 10); the user said "Phase 7 shuru karo" on 2026-10-22. This is Phase 7, "Visual Customizable Workflows" (inspired by monday CRM), of `docs/CRM_10_FEATURE_IMPLEMENTATION_PROMPT.md`. It is built in two parts: **7A** the workflow builder, **7B** boards and @mentions. **7A was built on 2026-10-22 (D86) and 7B the same day (D87)**; see sections 10A, 10B and 11.

## 1. Goal

An Indian SMB owner sets up "when a lead comes from IndiaMART, give it to Ravi and send the welcome template" without a consultant, sees **before turning it on** what it would do to a real lead, and is told exactly what is wrong when something is. The team looks at its leads and tasks the way each person works (a table, a board of columns, a calendar), saves those views, and pulls a colleague into a deal with **@name** in a comment.

## 2. What exists today (from the code)

- **The automation engine (Phase 6 of the roadmap, D30s–D48):** `Workflow` (trigger, ≤ 10 conditions, 1–20 steps), `AutomationRun` (one per subject, a log line per step, `dedupeKey`, loop guard `MAX_CHAIN` 4), the job queue, `engine.js` (`triggerMatches`, `conditionsMatch`, `runSteps`, waits), `actions.js` (12 actions, `fill`, `resolveVariables`), sequences.
- **Allowlists are enforced on the server:** 9 triggers, 5 condition fields, 12 actions (`constants/automation.js`); every trigger's and step's settings are checked by type (`validators/automation.js`), and `workflowService.checkReferences` checks people, templates, sequences and webhook addresses. **But both stop at the first problem.**
- **Pause and stop work:** setting a workflow to Paused cancels its running and waiting runs; `POST /automation-runs/:id/cancel` stops one run; a test run (`POST /workflows/:id/run`) takes an `Idempotency-Key`; runs are logged.
- **The builder** is a form on the Sales Automation page (`Sales Automation.html`, `js/automation.js`). Both files have the user's own uncommitted edits, so **this phase does not touch them**: the visual builder is a new page.
- **No preview** (dry run), **no ready-made workflows**, **no saved views or boards** (list columns are company-wide custom-field flags, D74), **no @mentions** (notes belong to contacts and tickets only).

## 3. Benchmark (official pages, checked 2026-10-22)

| What | Zoho CRM | monday CRM (inspiration) | This CRM after Phase 7 |
|---|---|---|---|
| Workflow rules | Rules per module limited by edition (10–150 per module; 5 or 10 conditions per rule) — [feature list](https://www.zoho.com/crm/help/complete-feature-list.html), [workflow FAQ](https://www.zoho.com/crm/resources/tips/workflow-rules-layouts.html) | Automation "recipes" in a sentence: "When status changes to X, notify Y" (UNVERIFIED: product pages, not checked line by line) | 9 triggers, 10 conditions, 20 steps with waits; **recipes**; a flow you can see |
| Visual process designer | Blueprint: drag-and-drop states and transitions (Settings → Automation → Blueprint) — [Blueprint overview](https://www.zoho.com/crm/tutorials/blueprint/overview.html) | Visual automation center | **Flow builder**: trigger → conditions → steps as cards, add / move (drag or keys) / remove |
| Check before saving | Errors on save | UNVERIFIED | **Every problem at once, on its card**, plus warnings (e.g. a WhatsApp text after 24 hours) |
| Try it first | No dry run found (UNVERIFIED) | No dry run found (UNVERIFIED) | **Preview on a real lead**: which conditions pass and what each step would do, nothing sent |
| Views | List views (private or shared) and Kanban views by a pick-list; no built-in calendar view found — [module views](https://help.zoho.com/portal/en/kb/crm/customize-crm-account/managing-module-views/articles/module-views), [Kanban FAQ](https://www.zoho.com/crm/resources/tips/customizing-kanban-view.html) | Boards with table, Kanban and calendar views | **Boards** for leads and tasks: table, Kanban, calendar; own columns; private or for the team |
| @mentions | "@" a user or group in a note: email and in-app alert; no alert for yourself — [CRM notes](https://www.zoho.com/crm/notes.html) | @mentions in updates | **@name in a deal's comments**: a bell note; only people who may see the deal can be mentioned; none for yourself |

## 4. Scope

### 7A — The workflow builder

1. **`POST /workflows/check`** (view permission): takes a draft (`name`, `trigger`, `conditions`, `steps`, all optional) and answers `{ ok, problems: [{ path, card, index, message, level }] }`.
   - `level` is `error` (saving would be refused) or `warning`.
   - **All** problems at once: the Joi checks with `abortEarly: false`, then every reference check (people, templates and their variables, sequences, webhook addresses).
   - `card` is `trigger`, `condition`, `step` or `workflow`; `index` is the condition's or step's place.
   - Warnings:
     - a wait as the last step does nothing;
     - a WhatsApp text in a workflow started by a time trigger of 24 hours or more, or after waits of 24 hours or more, will likely be outside WhatsApp's 24-hour window (use a template);
     - "send the payment link" needs an order (only order and payment triggers have one).
   - Saving keeps refusing on the first error, as today.
2. **`POST /workflows/preview`** (view permission, plus the lead visible to the member): `{ draft, leadId }`.
   - It runs nothing, sends nothing and changes nothing. An invalid draft is 400 with all problems.
   - It answers:
     - `trigger`: the type, and whether this lead would have started it, where that can be told from the lead (a source for "lead created", the current stage for "stage changed"); otherwise `null`;
     - `conditions[]`: each with `passed` and the lead's actual value;
     - `wouldRun`;
     - `steps[]`: each with `status` (`do`, `skip`, `wait`), a `reason` code for a skip, and `facts` (the filled-in text, the template's name and its filled variables, the person, the stage from and to, the task title and due date, when a wait ends, the webhook's host, the sequence's name).
   - The same engine code fills placeholders and checks conditions, so the preview cannot drift from real runs.
3. **`GET /workflows/recipes`**: 6 ready-made workflows to start from. A recipe's choices (who, which template) are left empty for the owner to pick, and the check says what is missing.
4. **Pause, stop and the run log** stay as they are, shown in the builder: an On/Paused switch, and the last runs with Stop.
5. **The page `workflow-builder.html`** (Sales Automation group in the sidebar, added by `app.js`; the automation module):
   - a picker for the company's workflows, New, and From a recipe;
   - the **flow**: a "When" card, an "Only if" card (conditions), then one card per step with a number, an icon and its settings; "+" between cards adds a step there;
   - steps move by dragging or by Up/Down buttons (keyboard and screen readers);
   - **problems show on their card** (checked as you edit, debounced), with a count at the top that jumps to the first one;
   - **Preview**: pick a lead by name and see the flow coloured by what would happen;
   - Save (create or update), the On/Paused switch, Delete, and the last runs with Stop;
   - English and Hindi; phones at 390 px (the flow is one column).

### 7B — Boards and @mentions

1. **`BoardView`** (per company): `object` (`lead` or `task`), `name`, `layout` (`table`, `kanban`, `calendar`), `filters`, `columns` (field keys), `groupBy` (Kanban), `dateField` (calendar), `sort`, `shared` (false = only its maker; true = the team), `ownerMemberId`.
   - At most 30 views per member and 50 shared per company.
2. **API:**
   - `GET /boards/meta`: per object, the fields (built-in and list custom fields), group-bys and date fields;
   - `GET /boards`: mine and the shared ones, for the objects whose module I have;
   - `POST /boards`; `PATCH`/`DELETE /boards/:id` (its maker, or owners and admins for shared views);
   - `GET /boards/:id/items?from&to&page`: the records, through the existing list services (so visibility, private records and masked phones apply).
3. **The page `boards.html`:**
   - a view picker; Table (the chosen columns, sortable), Kanban (cards in columns; dragging a lead between stage columns uses the existing stage move, and a task between status columns the task update) and Calendar (a month of the date field);
   - "Columns" to choose fields; filters; Save as view, Share with the team; English and Hindi; 390 px.
4. **Comments with @mentions on deals:**
   - `Note` takes `parentType: 'lead'` and `mentions[]`;
   - `GET/POST /leads/:id/comments` (lead visibility applies);
   - `GET /members/mentionable?leadId=&q=` lists only members who can see that deal;
   - posting checks every mentioned member again (an active member who can see the deal; else 422 naming them), and each gets a bell note (not the writer);
   - the deal box on the Deals board shows the comments, with an @ picker.

## 5. Data model

- 7A: no new collections. `constants/automation.js` gains `WORKFLOW_RECIPES`.
- 7B:
  - `BoardView`: `{ organizationId, object, name ≤ 80, layout, filters: Mixed (validated per object), columns: [String] ≤ 12, groupBy, dateField, sort, shared, ownerMemberId, createdById }`, with indexes on `(organizationId, ownerMemberId)` and `(organizationId, shared)`;
  - `Note.mentions: [ObjectId]`; `NOTE_PARENT_TYPES` gains `lead`.

## 6. API

| Method | Path | Notes |
|---|---|---|
| POST | `/workflows/check` | `{ ok, problems[] }`, 200 even when not ok |
| POST | `/workflows/preview` | `{ draft, leadId }` → trigger, conditions, steps; nothing runs |
| GET | `/workflows/recipes` | 6 drafts |
| GET | `/boards/meta`, `/boards` | 7B |
| POST/PATCH/DELETE | `/boards`, `/boards/:id` | 7B |
| GET | `/boards/:id/items` | 7B; existing visibility |
| GET/POST | `/leads/:id/comments` | 7B; mentions |
| GET | `/members/mentionable` | 7B; `leadId`, `q` |

## 7. Edge cases

- A draft with an unknown trigger or action: the check reports it, and saving is refused (as today); the preview is 400.
- A deleted or inactive person, a template that cannot be sent, a missing template variable: reported on that step's card.
- The preview for a lead the member cannot see: 404. For a lead with no phone: WhatsApp steps say "skip: no phone".
- A recipe used on a plan without workflows: the builder shows the plan message on Save, as today (the check and preview still work).
- Two people editing one workflow: the last save wins (as on the Sales Automation page).
- 7B:
  - a shared view uses a column that was deleted: the column is dropped when read;
  - a member without the Tasks module sees no task boards;
  - mentioning someone who cannot see the deal is refused by name;
  - mentioning yourself sends no note.

## 8. Acceptance checklist

- [x] The check lists every problem of a draft with its card and place; unsupported triggers and actions are rejected by the server (test).
- [x] The preview changes nothing (no messages, tasks, stage moves or runs), reports each condition, fills the text like a real run, and refuses a lead the member cannot see (test).
- [x] Recipes pass the check once their choices are made (test).
- [x] Pause cancels waiting runs; Stop cancels one run; a test run is idempotent (test, reusing the engine).
- [x] Browser (7A): build a workflow from a recipe, see problems on their cards, preview on a lead, save, pause, at 390 px and in Hindi; keyboard moves steps.
- [x] 7B: views per member and shared; items follow visibility; Kanban moves use the existing endpoints; mentions follow who may see the deal; bell notes (tests + browser).

## 9. Scorecard targets

| # | Target | How it is measured |
|---|---|---|
| 1 | A working workflow from a recipe in ≤ 6 clicks | Browser count |
| 2 | Every problem of a draft shown at once, on its card | Test + browser |
| 3 | A preview on a real lead with 0 side effects | Test (counts before and after) |
| 4 | Three layouts (table, Kanban, calendar) over leads and tasks, saved per member or shared | Test + browser |
| 5 | 0 regressions; 0 leaks (views, items, mentions); 390 px; Hindi | Full run + tests + browser |

## 10A. What was built in 7A (D86), and how it differs from this spec

Built on 2026-10-22 as specified, with these differences:

1. **An empty choice counts as "needed"** (code `REQUIRED` with the field), like a missing one, so the page can say it in the person's language. Other problems carry their code and an English message, which the page translates for the known codes.
2. **A new workflow's empty name** is not called a problem until it is typed in or saved.
3. **The preview also simulates the earlier steps**: a tag added in step 2 makes the same tag in step 3 "already so", a stage move changes what later steps see, and waits move the clock forward, so a WhatsApp text after a long wait is checked against the 24-hour window at that time. Skips name their reason ("the lead is already Suresh Kumar's").
4. **New workflows start as Draft**; the On switch makes them Active. Saving checks first (with the name) and points to the first problem.
5. **The page is linked from the sidebar** (Sales Automation → Workflow builder, added by `app.js` on every page). The Sales Automation page itself is unchanged, since it holds the user's own uncommitted edits.

Files:
- **Backend:** `constants/automation.js` (`WORKFLOW_RECIPES`), `validators/automation.js` (exports the settings schemas, `workflowDraft`, `workflowCheck`, `workflowPreview`), `services/workflowService.js` (`referenceChecks`, `check`, `preview`, `recipes`; `checkReferences` keeps refusing on the first problem), `routes/automation.js`.
- **Frontend:** `workflow-builder.html`, `js/workflow-builder.js`, `css/workflow-builder.css`, `js/app.js` (the sidebar link), and 183 texts (`wfb.*`, `nav.workflowBuilder`).
- **Tests:** `workflowBuilder.test.js` (4): every problem with its card; the preview with 0 side effects (messages, tasks, runs, jobs, activity and bell notes counted before and after) and its refusals; recipes; pause, stop and the idempotent test run.

Measured in the isolated preview (port 3100, an in-memory database, the tests' sign-in, the test WhatsApp number):
- **A working workflow from a recipe in 5 clicks** (target ≤ 6): "Start from a recipe", "Use this", pick the person, On, Save. The check showed the one missing choice on its card before.
- **The preview matched the real run**: on "TMT bars" it said "give the lead" would be skipped (already Suresh Kumar's) and the task "Call Gupta Steels about TMT bars 5 tonnes" would be made. A new IndiaMART lead then ran the saved workflow with exactly that (assign skipped, task done).
- **Keyboard and drag**: Up/Down moved a step and kept the focus on it; "+" added a step where pressed; a wait added last showed the note "A wait at the end does nothing".
- **390 px and Hindi**: no sideways scroll; the preview lines read in Hindi ("छूट जाएगा: लीड पहले से Suresh Kumar की है।").
- **Full run: 933 of 934 tests passed**; the one failure is the user's uncommitted `Sales Automation.html` (75 `auto.*` texts not added yet).

## 10B. What was built in 7B (D87), and how it differs from this spec

Built on 2026-10-22, with these differences:

1. **@mentions extend the deal's existing notes** (`LeadActivity`, `POST /leads/:id/activities`), as the build rules ask (no duplicate endpoint). So there is no `Note.parentType: 'lead'` and no `/leads/:id/comments`. A note takes `mentions[]`; `LeadActivity.mentions` keeps them; `GET /leads/:id/activities` names them; `GET /leads/:id/mentionable?q=` (not `/members/mentionable`) lists who can be mentioned.
2. **Who can be mentioned**: an active teammate with Leads or Deals who can open that deal (their own, or all with `view_all`; private deals only for owners). Anyone else is refused with 422 by name (`MENTION_NO_ACCESS`); someone of another company is `MENTION_UNKNOWN`. The bell note says "Suresh Kumar mentioned you on “TMT bars 5 tonnes”" and opens the deal (`Deals.html?open=<id>`). The writer gets none.
3. **A board saves itself as it is changed** (layout, columns, group, date, filters, sort, sharing). A shared board that is not yours is read-only, with **Save a copy**. So there is no separate Save button.
4. **Lists used by boards gained filters**: the lead list takes several stages or sources and ranges on the close date and creation; the task list takes several statuses or priorities and a range on creation. These are internal parameters from the board service; the public list validators are unchanged.
5. **Board items**: a table pages by 100 (sortable headings); Kanban and calendar read up to 300 records and say when there are more. A calendar asks for its range (from, to) on its date (task due days are calendar days in India time).
6. **Kanban moves** use the existing endpoints: a lead's stage through `POST /leads/:id/stage` (with its version; "Lost" asks why), its owner or source through `PATCH /leads/:id`, a task's status, priority or assignee through `PATCH /tasks/:id`. The card moves at once and goes back if the server refuses. "Move to…" does the same from the keyboard.
7. **Columns of the company's own lead fields** (`cf.<key>`) are offered. A field archived later drops out of the board when it is read.
8. **On a phone** the calendar becomes a list of the days that have something, and the Kanban columns scroll inside the board.

Files:
- **Backend:**
  - new: `constants/boards.js`, `models/BoardView.js`, `validators/boards.js`, `services/boardService.js`, `routes/boards.js`;
  - changed: `routes/index.js`, `services/leadService.js` (board filters, `mentionable`, mentions in `addNote` and `listActivities`), `models/LeadActivity.js`, `validators/crm.js` (`leadNote.mentions`, `mentionQuery`), `routes/leads.js`, `services/taskService.js`.
- **Frontend:** `boards.html`, `js/boards.js`, `css/boards.css`, `js/app.js` (the Boards link after Deals, `addLeadNote` with mentions), `js/deals.js` and `css/deals.css` (the @ picker and highlighted mentions), and 76 texts (`board.*`, `nav.boards`).
- **Tests:** `boards.test.js` (5): meta per module; private and shared boards and who changes them; items through the lists with each viewer's visibility, a calendar range and task boards; an archived field's column dropped; mentions (who can be, refusals by name, the bell note, not to the writer).

## 11. Scorecard results (measured 2026-10-22)

Measured in the isolated preview (port 3100, an in-memory database, the tests' sign-in): an owner and an agent who sees all leads, five deals with follow-ups, three tasks.

| # | Target | Result |
|---|---|---|
| 1 | A working workflow from a recipe in ≤ 6 clicks | **Met: 5 clicks** ("Start from a recipe", "Use this", pick the person, On, Save). |
| 2 | Every problem of a draft shown at once, on its card | **Met.** A test draft with 9 problems (an empty name, a wrong source, two bad conditions, a missing person, an unknown step, a template blank, a person not in the team, a wait at the end) got all of them, each on its card and field. In the browser the recipe's one missing choice showed on its card and the count said "1 to fix". |
| 3 | A preview on a real lead with 0 side effects | **Met.** The test counts messages, tasks, runs, jobs, activity and bell notes before and after: unchanged; the lead's stage and tags too. In the browser the preview matched the real run that followed. |
| 4 | Three layouts over leads and tasks, saved per member or shared | **Met.** A leads board went from table (sorted by value, a Source column added) to Kanban by stage ("Move to… Contacted" saved on the server) to a calendar on the follow-up day (five deals on their days; the next month too), then shared. The agent saw it read-only and saved a copy. Tests cover task boards. |
| 5 | 0 regressions; 0 leaks; 390 px; Hindi | **Met.** Full run: 944 of 945 tests passed. The only failure is the user's uncommitted `Sales Automation.html` (75 `auto.*` texts not added yet). Tests: an agent sees only their own leads on a shared board; another company gets 404 for a board and its items; a member without Leads gets no lead boards; mentions only reach people who can open the deal. Both pages at 390 px had no sideways scroll, in Hindi. |
