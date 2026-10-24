# Phase 10: Projects after the sale (spec)

Status: **approved with its defaults by the user's go-ahead of 2026-10-21** (all questions and defaults through Phase 10); the user said "Phase 10 shuru karo … aur uske baad final report" on 2026-10-23. This is Phase 10, "CRM plus Project Management" (inspired by Insightly), of `docs/CRM_10_FEATURE_IMPLEMENTATION_PROMPT.md`. It is built in two parts: **10A** projects, templates and "won → project", **10B** the screens.

## 1. Goal

A won deal is the start of the work: delivering the order, installing, setting up the service. The team should get the delivery project in one click (or by itself when the deal is won), with its milestones and tasks from a template, the right people on it and its dates. Sales should see on the deal and the customer how the delivery is going, without opening another tool.

## 2. What exists today (from the code)

- **Deals are leads.** Won is a stage; `lead.stage_changed` with `to: Won` goes on the automation bus after the change is saved (D84).
- **Tasks:**
  - linked to a record (`relatedType`/`relatedId`, types Customer, Contact, Lead, Deal, Account), assignees, due dates, status;
  - visibility: assigned or created, or `tasks:view_all`.
- **Calendar events** for meetings; **documents** linked to records.
- **Modules and permissions:**
  - 16 modules, each with view, create, edit, delete and `view_all`;
  - owners and admins have all; agents and viewers what they were given.
- **No projects, milestones or project templates.**

## 3. Benchmark (official pages, checked 2026-10-23)

| What | Zoho CRM | Insightly (inspiration) | This CRM after Phase 10 |
|---|---|---|---|
| Project from a deal | Through Zoho Projects (a separate product): New Project from the deal's related list, with a template, owner, dates and client users; needs the Create Project permission in Zoho Projects — [Zoho Projects integration](https://help.zoho.com/portal/en/kb/crm/integrations/zoho/zoho-projects/articles/use-zoho-projects-crm-integration) | Convert a won opportunity to a project (UNVERIFIED: product pages) | **Built in**: "Start the project" on a won deal, with a template, in one click |
| Automatic on Won | A custom function ("Create Projects While Winning Potentials") tied to a Deals workflow rule on Closed Won; one rule per template — [Sale to service delivery](https://www.zoho.com/one/guides/sale-to-service-delivery.html) | Workflow (UNVERIFIED) | **A switch**: every won deal gets its project with the chosen template, once |
| Progress on the CRM record | The CRM–Projects integration shows project progress (UNVERIFIED in detail) — [project management for CRM](https://www.zoho.com/crm/project-management.html) | Project status on the opportunity (UNVERIFIED) | **Status and progress on the deal and the customer** |
| Permissions | Zoho Projects roles, separate from CRM | Separate project permissions (UNVERIFIED) | **A Projects module** with its own view/create/edit/delete/view_all, apart from sales |

## 4. Scope

### 10A — Projects, templates, "won → project"

1. **A `projects` module:**
   - owners and admins have it; agents get it by default from now on; viewers can be given view;
   - an agent sees the projects they manage or are on (or all with `projects:view_all`);
   - having Leads gives nothing on projects, and the other way round.
2. **`Project`** (per company, soft delete):
   - a number (`PR-0001`), name, status (`not_started`, `in_progress`, `on_hold`, `completed`, `cancelled`);
   - the source deal (`leadId`, **unique per company**) and the customer;
   - the manager and the team, start and due dates, a description, the deal value, the template used;
   - **milestones** (embedded, up to 50: name, due date, done);
   - progress (computed), `completedAt`.
3. **Tasks are the existing `Task`** with `relatedType: 'Project'` and an optional `milestoneId`, so they show on the Tasks page and in reminders like any task.
   - **Progress** = done tasks ÷ all tasks; with no tasks, done milestones ÷ milestones.
4. **`ProjectTemplate`** (per company, owners and admins): a name, milestones (`name`, `dueAfterDays`), tasks (`title`, `milestone` index, `dueAfterDays`, `priority`, "for": the project manager or nobody), a default length in days.
5. **One click from a deal** — `POST /leads/:id/project { templateId?, name?, startDate?, managerId? }`:
   - only for a won deal the member can see, with Projects create;
   - **idempotent**: a second call (or a double click, or the automatic one) gives back the same project (200 instead of 201);
   - made in one transaction with its tasks.
6. **Automatic on Won** — Settings → Projects (owners and admins): "Start a project when a deal is won" with a template.
   - A won deal (from the board, the API, a workflow) queues a job keyed by the deal, which makes the project once;
   - Won → Lost → Won again makes nothing new.
7. **API:**
   - `GET/POST /projects` (filters: status, manager, mine, deal, customer, search);
   - `GET/PATCH/DELETE /projects/:id`;
   - `POST /projects/:id/milestones`, `PATCH`/`DELETE /projects/:id/milestones/:mid`;
   - `GET/POST /projects/:id/tasks`;
   - `GET /projects/summary?leadId=|contactId=` (for the deal and the customer: status and progress of the projects the viewer may see; for others, only that one exists);
   - `GET/POST/PATCH/DELETE /project-templates`;
   - `GET/PUT /projects/settings`.

### 10B — Screens

1. **`projects.html`** (sidebar, after Tasks):
   - a list of cards (status, progress bar, due date, customer, manager) with filters, and New project;
   - the project: status, dates, team, milestones as a checklist (add, tick, remove) and the tasks under them (add, tick);
   - the deal and customer links;
   - a Templates tab (owners and admins) and Settings → Projects in the same page (the automatic switch).
2. **The deal box:**
   - on a won deal, "Start the project" (template picker) or the project's status and progress with a link;
   - on others, nothing.
3. **Customer 360:** the customer's projects (status, progress) in the overview.
4. English and Hindi; 390 px.

## 5. Data model

- `Project { organizationId, number, name ≤ 120, status, leadId (unique per company, partial), contactId, managerId, memberIds[], startDate, dueDate, description ≤ 2000, valuePaise, templateId, milestones[{ _id, name, dueDate, done, doneAt }], completedAt, createdById, deletedAt }`.
- `ProjectTemplate { organizationId, name, milestones[{ name, dueAfterDays }], tasks[{ title, milestone, dueAfterDays, priority, forManager }], days }`.
- `Task.milestoneId`; `RELATED_TYPES` gains `Project`.
- `Organization.settings.projectsOnWon { enabled, templateId }`.
- Permissions: `MODULES` gains `projects`; agents' default modules gain it.

## 6. Edge cases

- A deal that is not won: 409 "Win the deal first".
- A deal won twice (the button and the automatic job at once): the unique key keeps one project; the second answer is the same project.
- A removed template: the project starts without it (a note); the automatic switch is turned off with a bell note to the managers.
- A deleted project: the deal can start a new one (the unique key ignores deleted projects).
- An agent with Leads but without Projects sees "a project exists" on the deal, not its details. Another company's project is 404.
- Progress with no tasks and no milestones: 0% until completed (then 100%).

## 7. Acceptance checklist

- [x] A repeated Won cannot duplicate a project; the one-click call is idempotent; a race between the button and the automatic job gives one project (tests).
- [x] The transaction makes the project and its tasks together (test).
- [x] Projects permissions differ from sales: Leads without Projects cannot read or start one; Projects without Leads cannot start from a deal they cannot see (tests).
- [x] Progress shows on the deal and the customer (test + browser).
- [x] Cross-company access is 404 (test).
- [x] Browser: start from a won deal with a template, tick milestones and tasks, progress moves, the deal and customer show it, at 390 px and in Hindi.

## 8. Scorecard targets

| # | Target | How it is measured |
|---|---|---|
| 1 | A won deal to a delivery project with its tasks in ≤ 2 clicks (0 when automatic) | Browser count |
| 2 | 0 duplicate projects under repeats and races | Tests |
| 3 | Delivery progress visible from the deal and the customer | Browser |
| 4 | Project permissions separate from sales, 0 cross-company leaks | Tests |
| 5 | 0 regressions; 390 px; Hindi | Full run + browser |

## 9. What was built (D92), and how it differs from this spec

Built on 2026-10-23 and 2026-10-24, with these differences:

1. **A removed template** leaves the automatic switch on: won deals then start projects without a template (the spec said to switch it off with a bell note). A project already started keeps its milestones and tasks.
2. **Customer 360** shows the customer's projects under the **Deals** tab (the spec said the overview), next to the deals they came from.
3. **The deal box picks the first template** for you, so a won deal becomes a project in one click; "No template" is the last choice.
4. **A project's task stays on its project:** the Tasks page shows "Project: …" and its form can no longer take the task off the project (found in the browser check: saving the form sent an empty "related to").
5. **Who sees what:**
   - owners, admins and `projects:view_all` see every project; others see the projects they manage, are on, or made;
   - someone with Leads but no Projects sees "This deal already has a project that you cannot open" on the deal, not its details;
   - templates and the automatic switch are for owners and admins.
6. **Found and fixed while checking (two tests that failed now and then):**
   - the SMS sequence test (D88) waited for working hours, so it failed when run before 9 am; its two sequences now ignore the clock (`sms.test.js`);
   - the pipelines migration test (D84) made its three old leads a millisecond apart under load; they now share one time (`pipelines.test.js`).

Files:
- **Backend:**
  - new: `constants/projects.js`, `models/Project.js`, `models/ProjectTemplate.js`, `services/projectService.js`, `validators/projects.js`, `routes/projects.js`;
  - changed: `constants/permissions.js` (the `projects` module), `constants/crm.js` (`Project` related type, `project` task origin), `models/Task.js` (`milestoneId`), `models/Organization.js` (`settings.projectsOnWon`), `services/workItemService.js` (project names, tasks stay on their project), `routes/index.js`, `routes/leads.js` (`POST /leads/:id/project`), `jobs/index.js`.
- **Frontend:**
  - new: `projects.html`, `js/projects.js`, `css/projects.css`;
  - changed: `js/app.js` (the menu link after Tasks, the page's module), `js/deals.js` (the deal box's project), `js/customer-360.js` (the customer's projects), `js/task.js` ("Project: …"), `js/accounts.js` and `js/settings-pages.js` (the Projects module), `css/style.css`;
  - 56 texts (`proj.*`, `nav.projects`).
- **Tests:** `projects.test.js` (4):
  - a won deal's project from its template, once (a double click gives the same project), the progress on the deal and the customer, milestones, a deleted project and a new start;
  - four starts at once give one project;
  - the automatic start on Won, once (lost and won again, the job run twice), and nothing when switched off;
  - Projects apart from sales, members see their projects, other companies get 404.

## 10. Scorecard results (measured 2026-10-24)

| # | Target | Result |
|---|---|---|
| 1 | A won deal to a delivery project with its tasks in ≤ 2 clicks (0 when automatic) | **Met: 1 click** in the open deal box ("Start the project", the template already chosen): the project with 3 milestones and 4 tasks. **0 clicks** with the switch on: a deal moved to Won had its project (4 tasks) within a second. |
| 2 | 0 duplicate projects under repeats and races | **Met (tests).** A double click answers with the same project; four calls at once make one; lost and won again, and the job run twice, still one. A unique index per deal backs it. |
| 3 | Delivery progress visible from the deal and the customer | **Met.** Ticking a task moved the project from 25% to 50% on the Projects page; the deal box and Customer 360 showed "चल रहा है · 50% पूरा" in Hindi. |
| 4 | Project permissions separate from sales, 0 cross-company leaks | **Met (tests).** Leads without Projects: 403 to list or start, count only on the deal. Projects without the deal visible: 404. Another company: 404 and a count of 0. |
| 5 | 0 regressions; 390 px; Hindi | **Met.** **Full run: 983 of 984 tests passed**; the one failure is the user's uncommitted `Sales Automation.html` (75 `auto.*` texts not added yet). The Projects page, the deal box, Customer 360 and the Tasks page at 390 px had no sideways scroll, in Hindi. |

**Known limits:**
- No Gantt chart, time tracking or project billing yet; progress is tasks done (or milestones when a project has no tasks).
- Milestones and tasks are added one by one on the project; a template is the way to add many at once.
- The automatic start uses the deal's owner as the manager.

