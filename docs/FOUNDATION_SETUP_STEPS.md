# Foundation, week 1: your steps (F1–F4a)

What the code now does is in `docs/FOUNDATION_30_DAY_PLAN.md`. These are the steps only you can do, in order. Keys and passwords go straight into Render, Atlas, Cloudflare or a password manager. Never paste them in a chat, an email or a file in the repository.

Button names come from each service's pages on 2026-10-24; services move buttons now and then. If a screen looks different, the words in bold are what to look for.

## A. GitHub: tests on every push (F1)

1. Push the commits to GitHub (`main`).
2. Open the repository on github.com → **Actions** → **Tests**. The first run takes 10–15 minutes (it downloads the test database once); later runs are faster. It must end green.
3. Make the `staging` branch, the same as `main`, from the project folder:

   ```bash
   git push origin main:staging
   ```

From now on:
- Work for production goes to `main`.
- To try something on staging first, push it to `staging`.
- Render deploys a branch only after its tests pass.

## B. Atlas: the staging database and production backups (F2, F4a)

**Staging database (free):**
1. Atlas → **New Project** → name it `YELLOW CRM staging`.
2. **Create** a cluster → **M0 (Free)** → provider AWS, region **Mumbai (ap-south-1)**.
3. **Database Access** → **Add New Database User**. Choose a new user name and password, and keep them in your password manager.
4. **Network Access** → **Add IP Address** → **Allow access from anywhere** (`0.0.0.0/0`), as for production.
5. **Connect** → **Drivers** → copy the connection string, and put the new password in it. You need it in step C.

This is staging's own database. **Never put the production connection string into staging.**

**Production backups:**
1. Open the production project → the production cluster.
2. If its tier is **M0** or **Flex**, choose **Edit Configuration** → **M10** → **Apply**. Do it at a quiet time: Atlas may pause the database for a few minutes during this change (unverified).
3. **Backup** → make sure **Cloud Backup** is on. Keep daily snapshots for at least 7 days.

## C. Render: the deploy gate and the staging service (F1, F2)

1. Render dashboard → **Blueprints** → the YELLOW CRM blueprint → **Manual Sync** (or wait for the sync after your push). Render reads the new `render.yaml`:
   - **yellow-crm** (production) now deploys only after the checks pass;
   - a new service **yellow-crm-staging** appears.
2. Open **yellow-crm-staging** → **Environment**. Set these three (Render does not ask for them when an existing Blueprint is synced):

   | Key | Value |
   |---|---|
   | `MONGO_URI` | the **staging** connection string from step B |
   | `GOOGLE_CLIENT_ID` | the same as production (copy from production's Environment tab) |
   | `PUBLIC_URL` | staging's address, e.g. `https://yellow-crm-staging.onrender.com` (Render shows it at the top) |

   Save. Render deploys staging.
3. Open `https://<staging address>/api/v1/health`. It must say `"environment":"staging"` and `"status":"UP"`.
4. Check both services' **Settings → Auto-Deploy**: it should say the deploy waits for the CI checks.

## D. Google sign-in on staging (F2)

Google Cloud Console → **APIs & Services → Credentials** → your OAuth client → **Authorized JavaScript origins** → add `https://<staging address>` → Save.

Then open `https://<staging address>/crm/frontend/login.html`:
1. Sign in with your Google account. A new company is made for you there.
2. A yellow band at the top says this is staging.
3. Press **Fill with sample data**: ten made-up customers with deals, tasks, products and a project appear.

## E. Sentry: error reports (F3)

1. Sign up at sentry.io (the free plan is enough).
2. **Create Project** → platform **Node.js** → name `yellow-crm`.
3. **Settings → Projects → yellow-crm → Client Keys (DSN)** → copy the DSN.
4. Render → **yellow-crm** → **Environment** → **Add** `SENTRY_DSN` = the DSN → Save. Do the same on **yellow-crm-staging**, with the same DSN. Sentry tells them apart by environment (`production` and `staging`).
5. Check that Sentry emails you about new issues: **Settings → Account → Notifications** → Issue alerts on, and the project's **Alerts** has a rule that emails on new issues.
6. Test it: on staging, press **Send a test error** in the yellow band. Within a minute, Sentry shows "Test error from the developer tools (F3)", and the email follows.

What reaches Sentry:
- **Sent:** the error, the page or address (without the part after `?`), and member and company ids.
- **Never sent:** customers' phone numbers, emails, message text, passwords or tokens. They are removed before sending.

## F. UptimeRobot: the email when the site is down (F3)

1. Sign up at uptimerobot.com (free).
2. **Add New Monitor** → type **Keyword** → URL `https://<production address>/api/v1/health` → keyword `"status":"UP"` → alert when the keyword **does not exist** → interval **5 minutes** → your email as the alert contact.
3. Do the same for staging's address.

## G. WhatsApp alerts: the watchdog (F3)

A small Cloudflare Worker checks both sites every 2 minutes. After 2 failed checks in a row (about 5 minutes) it sends you one WhatsApp message. While the site stays down, it reminds you every 2 hours. When the site is back, it sends one more message. It runs outside the CRM, so it still works when the CRM is down. Its code is `ops/alert-worker/worker.js`.

**1. The WhatsApp template (Meta):**
1. WhatsApp Manager → **Message templates** → **Create template** → category **Utility** → name `crm_alert` → language **English**.
2. Body: `YELLOW CRM alert: {{1}}. Please check the CRM.`
3. Sample for `{{1}}`: `Production is DOWN: answered 503` → **Submit**. Wait for **Active** (approval).
4. The sender is the platform's own WhatsApp number: its **phone number ID** and a permanent access token. If you set up the login-code number (`WHATSAPP_OTP_*`), the same number and token work.
5. Each alert is a paid business-initiated message, a few a month at most.

**2. The Worker (Cloudflare):**
1. Sign up at cloudflare.com (free) → **Workers & Pages** → **Create** → **Worker** → name `yellow-crm-watchdog` → **Deploy**.
2. **Edit code** → replace everything with the contents of `ops/alert-worker/worker.js` → **Deploy**.
3. **Storage & Databases → KV** → **Create** a namespace `crm-watchdog`.
4. Back on the Worker → **Settings → Bindings** → **Add** → **KV namespace** → variable name `STATE` → choose `crm-watchdog`.
5. **Settings → Variables and Secrets** → add:

   | Name | Type | Value |
   |---|---|---|
   | `SITES` | Text | `Production\|https://<production address>/api/v1/health,Staging\|https://<staging address>/api/v1/health` |
   | `WA_PHONE_NUMBER_ID` | Text | the sender's phone number ID |
   | `WA_TO` | Text | your WhatsApp number with country code, e.g. `9198…` (several: separate with commas) |
   | `WA_TEMPLATE` | Text | `crm_alert` |
   | `WA_TOKEN` | **Secret** | the sender's permanent access token |
   | `TEST_KEY` | **Secret** | a long made-up word, only for the test address |

6. **Settings → Triggers → Cron Triggers** → **Add** → `*/2 * * * *` (every 2 minutes).
7. Test it: open `https://yellow-crm-watchdog.<your-subdomain>.workers.dev/test?key=<TEST_KEY>`. A WhatsApp test alert must arrive. `/check?key=<TEST_KEY>` shows what the last check saw.

## H. Check that week 1 works

| Check | How | Expected |
|---|---|---|
| Tests on every push | Push anything | **Actions → Tests** green in ≤ 15 minutes |
| A failing test blocks production | Render → yellow-crm → **Events** after a red run | No deploy for that commit |
| Errors reach you | Staging → **Send a test error** | Sentry issue + email |
| Down site reaches you | Render → yellow-crm-staging → **Suspend**, wait 5 minutes, then **Resume** | WhatsApp "Staging is DOWN", UptimeRobot email, then WhatsApp "back up" |
| Backups | Atlas → production → **Backup** | A snapshot from today |

Tell me what you saw (not the keys), and we go on to week 2 (files on Cloudflare R2).
