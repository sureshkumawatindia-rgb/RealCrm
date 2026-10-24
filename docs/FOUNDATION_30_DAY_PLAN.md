# Foundation plan: the first 30 days (F1–F7)

Written 2026-10-24, from the "116 points" list (points 5, 43–49 and 55). Goal: before the first real
customer, the CRM must be tested on every change, watched, backed up, able to run on two servers,
and protected by a second login step for owners and admins.

## 1. The user's answers (2026-10-24)

| Question | Answer |
|---|---|
| Where the CRM runs | Live on Render, no real users yet |
| Extra monthly budget | Up to ₹10,000 |
| Uploaded files | Cloudflare R2 |
| 2FA | Authenticator app; required for owners and admins, optional for others |
| Monitoring | Sentry (errors) + UptimeRobot (site up/down) |
| Alerts | Email + WhatsApp |
| Deploy | Push runs the tests; `main` goes to production only when they pass; `staging` branch to staging |
| Staging database | A separate free Atlas database with made-up data; customer data never goes to staging |

The user pushes; I never push.

## 2. What the code has today (checked 2026-10-24)

- **CI:** `.github/workflows/static.yml` only deploys static pages to GitHub Pages. No tests run on push.
- **Deploy:** `render.yaml` has one web service (Singapore, 1 CPU / 2 GB) that runs everything. `autoDeployTrigger: commit`: every push to `main` deploys, tested or not. A 5 GB Render disk holds the files, which keeps the service to one instance.
- **Database:** MongoDB Atlas (`docs/RENDER_SETUP.md`); backups are "turn on Atlas Cloud Backup" (paid tier).
- **Job queue** (`jobs/queue.js`): jobs are claimed with a MongoDB lock (`lockedBy`, `lockUntil`), so it is already safe on two servers.
- **Files:** documents go through `storage/index.js` (a local-disk driver; the comment already plans S3/R2). Logos are written straight to `UPLOAD_DIR` (`organizationService.js`), served by `express.static` (`app.js`) and read by the quotation PDF and page.
- **Not ready for two servers:**
  - the live inbox (`realtime/socket.js`, Socket.IO) only reaches people on the same server;
  - the rate limits (`middleware/rateLimit.js`) are kept in each server's memory;
  - migrations run at every start (`server.js`), so two servers would run them at once;
  - `whatsappInboundService.js` has its own timer (line 589) that retries inbound events, which must not run twice on one event.
- **In-memory caches that stay fine on two servers:** the 30-second "hide phone numbers" cache, the typing indicator throttle.
- **Login:** Google, login code, QR approval; "log out other devices" exists. No 2FA.
- **Monitoring:** none (no Sentry or similar); `/api/v1/health` exists.

## 3. Work, week by week

Each step: build → tests → check on staging → commit my files → the user pushes.

### Week 1: F1 CI, F2 staging, F3 monitoring and alerts, F4a backups on

**F1. Tests on every push**
- A GitHub Actions workflow on every push and pull request: `npm ci`, the MongoDB test binary cached between runs, `jest -w 2`.
- `render.yaml`: production deploys only when the checks pass (Render's "deploy after checks pass" setting; its exact Blueprint name to be checked in Render's docs, UNVERIFIED).
- Done when: a failing test blocks the deploy of `main`; a run takes ≤ 15 minutes.
- The user: push, and turn on branch protection for `main` on GitHub (steps given).

**F2. Staging**
- A second service in `render.yaml` from the `staging` branch, on a small instance, with its own secrets and its own database (Atlas M0, free).
- A seed script makes one made-up company with members, customers, leads, deals, tasks and a project.
- Providers stay on their stand-ins in staging (`DEV_TOOLS` on), so no real WhatsApp, SMS or calls go out.
- Done when: a push to `staging` deploys there; production data is never readable from staging.
- The user: create the Atlas M0 database and add the staging web address to the Google sign-in client (steps given).

**F3. Monitoring and alerts**
- Sentry in the backend and the pages, errors only at first. Phone numbers, emails, tokens and message text are removed before anything is sent.
- `/api/v1/health` reports the database, the job queue's delay and the version, without secrets.
- UptimeRobot checks production and staging every 5 minutes.
- Alerts go by email (from Sentry and UptimeRobot) and by WhatsApp. When the CRM itself is down it cannot send WhatsApp, so a small Cloudflare Worker (free) receives both tools' alerts and sends the WhatsApp message through the WhatsApp Cloud API with an approved template.
- Done when: a test error and a stopped staging server each reach email and WhatsApp within 5 minutes.
- The user: Sentry and UptimeRobot accounts, a Meta-approved "CRM alert" template, and the Worker's keys (entered by the user in Cloudflare, never pasted to me).

**F4a. Backups on**
- Production on Atlas M10 with Cloud Backup on (daily snapshots).
- An extra weekly export to a separate R2 bucket, so a copy lives outside Atlas.
- The user: the M10 upgrade and turning on Cloud Backup in Atlas (steps given; Atlas may need a short pause during the upgrade from a free tier, UNVERIFIED).

### Week 2: F5 files on Cloudflare R2

- An R2 driver for `storage/index.js` (R2 speaks the S3 protocol) with the same put / open / remove functions.
- Logos move behind the same storage, so nothing writes to the server's disk.
- Buckets are private, one per environment. Files are still downloaded through the CRM, so the same permission checks apply.
- A one-time script copies the files from the Render disk to R2 and compares their sizes and checksums. The disk is read as a fallback until every file is found in R2.
- Done when: uploads, downloads, quotation logos and WhatsApp media work on staging with no disk; the copy reports 0 missing files.
- The user: an R2 bucket per environment and an access key (entered in Render and `backend/.env` by the user, steps given).

### Week 3: F6 two servers

- The live inbox through a MongoDB adapter for Socket.IO, so an update on one server reaches people on the other (no Redis bill).
- The login, code and OTP limits shared through MongoDB (they stop password-guessing). The general API limits stay per server, so with two servers someone gets up to twice the per-minute limit (written down).
- Migrations behind a lock: one server runs them, the other waits.
- The WhatsApp inbound retry timer claims each event before working on it, so two servers never handle one event twice.
- `render.yaml`: the disk removed, two instances.
- Done when, on staging with two instances: one stopped by hand, logins, the live inbox, uploads and jobs keep working; a load test (a few hundred users at once) gives a first baseline.
- The user: raise the production instance count on Render after staging passes.

### Week 4: F7 2FA, F4b the restore drill

**F7. 2FA with an authenticator app**
- Set up from **My profile**: a QR code for Google Authenticator or a similar app, a 6-digit code to confirm, 10 one-time backup codes (stored hashed).
- After Google sign-in, a login code or a QR login, a person with 2FA enters a 6-digit code. "Remember this device for 30 days" is offered.
- A QR login approved from a device that already passed 2FA counts as passed.
- Owners and admins must turn it on: after release they have 7 days, then they are sent to the set-up page until they do.
- Lost phone and no backup codes: another owner or admin of the company turns it off for them (audited); a company with one owner uses the platform's support script (audited).
- The secret is encrypted with `DATA_ENCRYPTION_KEY`; attempts are limited; set-up, use and reset are in the audit log and the login alerts.
- Done when: tests cover set-up, a wrong code, a used backup code, the 7-day rule, the reset; in the browser the extra step takes ≤ 10 seconds, in English and Hindi, at 390 px.

**F4b. Restore drill**
- Restore the latest snapshot into a temporary Atlas cluster (never staging), count customers, leads and documents against production, then delete the temporary cluster.
- Done when: the restore and the counts take under an hour; the steps are written down for next month.

## 4. What the user does (accounts and keys)

Never paste a key, password or code to me. Each key goes into Render's Environment tab or `backend/.env` by the user, following numbered steps (backup, edit, restart).

1. GitHub: push; branch protection for `main`.
2. Render: the staging service from the Blueprint; later, two instances for production.
3. MongoDB Atlas: production to M10 with Cloud Backup; a free M0 for staging; a temporary cluster for the restore drill.
4. Cloudflare: R2 buckets and access keys; the alert Worker's keys.
5. Sentry and UptimeRobot accounts.
6. Meta: approval of the "CRM alert" WhatsApp template.
7. Google Cloud: the staging web address in the sign-in client.

## 5. New settings (names only)

`SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `STORAGE_DRIVER` (`disk` or `r2`), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. The final names are fixed when each step is built.

## 6. Cost per month (approximate, to be confirmed on the pricing pages, UNVERIFIED)

| Item | About |
|---|---|
| Render: 2 production instances (1 CPU / 2 GB) | $50 |
| Render: staging (small instance) | $7 (or the free tier, which sleeps when idle) |
| Atlas M10 with Cloud Backup | $57+ |
| Cloudflare R2 (10 GB free), Worker, Sentry, UptimeRobot, GitHub Actions | $0 on their free tiers at this size |
| **Total** | **about $115 ≈ ₹9,500–10,000** |

The second production instance is turned on only after F6 passes on staging, so the first weeks cost less.

## 7. Risks and how they are avoided

- **Changing `render.yaml` changes production on the next push.** Every change is tried on staging first, and production changes are pushed one at a time.
- **Moving files.** Copy first and compare; the disk stays as a fallback until 0 files are missing; the disk is removed last.
- **Locking owners out with 2FA.** Backup codes, the 7-day window, a reset by another owner or admin, and an audited support script.
- **Alerts that never arrive.** Each alert path is tested once on purpose (F3).
- **Data in staging.** Staging has its own database and never a copy of production; the restore drill uses a temporary cluster.

## 8. Scorecard targets

| # | Target | How it is measured |
|---|---|---|
| 1 | Every push tested in ≤ 15 minutes; a failing test blocks production | GitHub Actions run times; a deliberately failing test |
| 2 | An error or a down site reaches email and WhatsApp in ≤ 5 minutes | Test error; staging stopped on purpose |
| 3 | A backup restored and checked in under an hour | The restore drill |
| 4 | One of two servers stopped: 0 failed logins, 0 lost files, live inbox still live | Staging with two instances |
| 5 | Owners and admins cannot skip 2FA after 7 days; the extra step takes ≤ 10 seconds | Tests + browser |

## 9. Week 1: what was built (D93, 2026-10-24), and how it differs from the plan

Your steps are in `docs/FOUNDATION_SETUP_STEPS.md`.

**F1. Tests on every push**
- `.github/workflows/tests.yml` runs the backend and page tests (`jest -w 2`) and the watchdog's tests on every push and pull request. The test MongoDB is kept between runs.
- `render.yaml`: production deploys with `autoDeployTrigger: checksPass` (the name checked in Render's Blueprint spec on 2026-10-24).
- Not run on GitHub yet: it needs your push (UNVERIFIED until then).

**F2. Staging**
- A second service, `yellow-crm-staging`, from the `staging` branch (`0.5c-512mb`, no disk), with its own generated keys and its own database.
- `APP_ENV` (production, staging, development, test). On staging:
  - the developer test tools may be on;
  - **only the test stand-ins can be used**: Exotel, MSG91 and real WhatsApp numbers are refused, and Google and Microsoft use their stand-ins;
  - search engines are told not to index it.
- A yellow band on every page says it is staging. For owners and admins it has **Fill with sample data** (`POST /api/v1/staging/sample-data`, once per company: 4 products, a project template, 10 customers with deals at every stage, 6 tasks, a project from a won deal, all made through the CRM's own API) and **Send a test error**.

**F3. Monitoring and alerts**
- **Error reports to Sentry** (`services/errorReporter.js`) by Sentry's envelope protocol, without its SDK. They come from:
  - the API's 5xx answers;
  - jobs that gave up;
  - crashes (reported, then the process ends as before);
  - the pages (`POST /api/v1/client-errors`, at most 5 a page, 20 a minute from one address).
- **What is taken out before sending:** phone numbers, emails, tokens and the part of an address after `?`.
- **Limits:** at most 30 reports a minute, the same error once a minute, and Sentry's 429 is honoured.
- **`/api/v1/health`** now also gives the environment, the version (Render's commit) and how late the background jobs are. More than 15 minutes late = `DEGRADED`.
- **Different from the plan:** the watchdog (`ops/alert-worker/worker.js`, a Cloudflare Worker) checks the sites itself every 2 minutes and sends the WhatsApp alert after 2 failed checks. It does not wait for UptimeRobot's or Sentry's webhooks. UptimeRobot sends the emails; Sentry emails new errors.
- Real Sentry and real WhatsApp alerts are UNVERIFIED until your DSN, template and Worker are set up. In the tests, a stand-in Sentry received the envelopes.

**F4a. Backups**
- Atlas M10 with Cloud Backup: your steps (section B of the steps).
- **Moved to week 2:** the weekly extra copy on R2. It needs the R2 code that week 2 adds anyway.

**Also found:** a fake Sentry in the tests kept connections open and would have kept CI waiting; the test closes them.

**Tests:**
- `foundation.test.js` (6): envelopes, scrubbing, once a minute, 429, no DSN; 5xx, jobs and page errors reported, 4xx not; health; sample data once and only for owners/admins; 404 in production; staging's refusals.
- `ops/alert-worker/worker.test.js` (7): checks, the two-failure rule, reminders, back up, the template message, state between runs, no writes while healthy.
- **Full run: 989 of 990 tests passed**; the one failure is the user's uncommitted `Sales Automation.html` (75 `auto.*` texts not added yet).

## 10. Week 2: what was built (D94, 2026-10-24), and how it differs from the plan

Your steps: sections I–M of `docs/FOUNDATION_SETUP_STEPS.md`.

**F5. Files on Cloudflare R2**
- `STORAGE_DRIVER=r2` keeps documents, WhatsApp media, attachments and imports (`documentStorage`) and, new, the companies' logos (`logoStorage`) on R2. `disk` (the default) keeps them in the two folders, as before.
- R2 is reached by the S3 protocol (`storage/r2Client.js`, `storage/s3Signer.js`), signed with SigV4 without the AWS SDK. The signer matches AWS's signing test suite (botocore's `get-vanilla` and `get-vanilla-query-order-key`).
- Large files are sent in parts. Every request has a timeout.
- **Keys stay the same:** documents keep their saved key under `documents/`, logos their file name under `logos/`, so nothing in the database changes.
- **Old files still open:** with R2, a file not found there is read from the disk folders (`STORAGE_DISK_FALLBACK`, on by default) until the copy is done.
- **Logos:** `/uploads/<name>` now comes from the storage, at the same address as before, with the same "no scripts" header. Unknown or unsafe names get 404. The quotation PDF and page read the logo from the storage too.
- **The copy:** `scripts/files-to-r2.js` copies each file and checks it (MD5 ETag, else the bytes). `--check` only compares. Nothing on the disk is changed.

**F4a (the rest). The weekly backup copy**
- `services/backupService.js`, job `backup.weekly`, every Sunday at 2:30 in India, when `R2_BACKUP_BUCKET` is set.
- **Format:** one file per collection, Extended JSON lines (ids and dates kept), gzipped, encrypted with AES-256-GCM under a key derived (HKDF) from `DATA_ENCRYPTION_KEY`.
- **Manifest:** a manifest with counts, sizes and SHA-256 is written last, so a copy without it is incomplete.
- **Kept:** the newest 8 copies (`BACKUP_KEEP_WEEKS`).
- **By hand:** `scripts/backup.js list | run | check`. `check` downloads, decrypts and counts every file against the manifest, and finds a changed file.

**Different from the plan:**
- The R2 code was written without a library, as the CRM's Excel and Sentry code were.
- Restoring a copy into a database is week 4 (F4b); this week proves a copy can be read back and counted.

**Checked:**
- In the isolated preview, with a stand-in R2 that checks every signature: a logo and a document went to R2, came back (200, `image/png`; the file's text), and the logo showed on the page.
- Real R2 is UNVERIFIED until your steps.

**Tests:** `storage.test.js` (5):
- the AWS signing vectors;
- the client: put, get, head, list page by page, multipart, a wrong key → 403;
- documents on R2 with the old one from the disk; logos at `/uploads`, unsafe names 404;
- the copy, a second run, a changed copy caught;
- backups: encrypted (no email in the file), read back, a changed file caught, old ones removed; the Sunday time.

**Full run: 994 of 995 tests passed**; the one failure is the user's uncommitted `Sales Automation.html` (75 `auto.*` texts not added yet).

