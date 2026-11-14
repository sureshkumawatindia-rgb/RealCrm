# Saturday updates: the weekly round after the launch

From the launch on 14 November 2026, agreem360 CRM is updated **once a week, on Saturday**
(the owner's decision). Customers get one tested update a week instead of changes every day, and
the list below is where everything waiting for a Saturday is kept.

## The round, every Saturday

1. **Check from outside** (15 min), in the `backend` folder:
   - `npm run rehearsal -- https://crm.agreem360.com --site https://agreem360.com`: no FAIL.
   - GitHub → Actions: the last "Tests" run on `main` is green.
   - Platform admin → **Health**: problems of the week, webhooks not processed, jobs that gave up.
   - The status page `/status`: anything red in the last 7 days.
2. **Look at the week** (15 min): customers' questions and requests (support WhatsApp, the pilot
   group), Settings → Failed sends of the owner's own company, Sentry errors (once set up).
3. **Choose** what goes in this Saturday's update: the most asked request, anything broken first,
   then one item from the list below. The owner says yes before work starts.
4. **Build and test**: the change, then `npx jest` (about 13 min) and `npm run e2e` (about 5 min).
   Nothing goes out with a red test.
5. **Ship** (owner's OK): commit, push to `main`; GitHub runs the tests and Render deploys only
   when they pass (`autoDeployTrigger: checksPass`). Then the rehearsal check again on the live
   address.
6. **Tell**: a short "What's new" line for customers (in Hindi and English) and a row in
   `docs/BIZNUMA_ROADMAP.md` (decision + changelog).

Big changes go to staging first (`git push origin main:staging`, docs/FOUNDATION_SETUP_STEPS.md).
Urgent fixes (sign-in broken, data wrong, security) do not wait for Saturday.

## Waiting for a Saturday (newest at the end)

| # | What | Why it waits | Notes |
|---|---|---|---|
| 1 | **Mongoose security update** (to 9.11.4 or later) | `npm audit` says high; 9.11.4 and 9.12.1 bring MongoDB driver 7.7/7.8, which the tests' MongoDB 8.2.6 refused with "Missing required sub-document 'driver' in the client metadata document" (2026-11-14) | First item. Try a newer mongodb-memory-server / driver, then staging with Atlas before production. Every request body is checked by Joi first, which keeps the risk low until then (D154). |
| 2 | 5 moderate `npm audit` items (gaxios, gcp-metadata, glob, minimatch, rimraf) | They come inside googleapis; no fix without its next version | Re-check each round. |
| 3 | Pickers for tasks, events, documents and tickets, and the Deals list view, read the newest 5,000 records | Matters only for very large companies | docs/SPEED_AT_SCALE.md "Left". |
| 4 | Lead search looks through at most 1,000 matching customers | As above | docs/SPEED_AT_SCALE.md. |
| 5 | The home page and the agreem360 website have no dark mode | The CRM pages have it; the public pages are light only | CP5 note. |
| 6 | Texts the server writes (bell notes, chat previews, some emails) are English for Hindi users | The pages and their scripts are Hindi (D116); the server's own texts were never part of it | Check which ones customers see most. |
| 7 | The owner's own pages still outside the Hindi guard: Sales Automation, Calendar, Marketing, js/automation.js, js/marketing.js, js/marketing-broadcasts.js, js/automation-bot.js | Left to the owner (D116) | Move each into the guard once it is done. |
| 8 | A full logo that reads "agreem360" | `img/logo/logo.png` reads "AGREEM CRM", so pages show the "A" mark (D150) | Needs the owner's new logo file. |
| 9 | Workflow builder at 320 px: an invisible chip checkbox sits 8 px past its field | Cosmetic, not visible | docs/RESPONSIVE_GUIDE.md. |
| 10 | Customers connecting their own WhatsApp (Embedded Signup) | Needs Meta business verification, Tech Provider and App Review (weeks) | GO_LIVE_CHECKLIST step 7; the code is ready. |
| 11 | Razorpay plan payments, Resend emails, R2 files, Sentry, UptimeRobot | The owner's accounts (GO_LIVE_CHECKLIST) | The 45-day trial gives time for payments. |
| 12 | Production's disk removal and two instances | Only after `files-to-r2.js --check` shows 0 missing, with the owner's word | docs/FOUNDATION_SETUP_STEPS.md section O. |
| 13 | The old phase 9 work folder (a scratchpad worktree on branch `feature/phase-9`) | Its work is in `main` (f03c24a); the folder and branch are only leftovers | `git worktree remove` + `git branch -D feature/phase-9`, with the owner's OK. |

When an item is done, move it out of this table into the roadmap with its decision number.
