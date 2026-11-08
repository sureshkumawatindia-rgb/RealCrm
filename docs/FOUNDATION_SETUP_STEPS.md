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

---

# Week 2: files on Cloudflare R2, and the weekly backup copy (F5, F4a)

After these steps, uploads (documents, WhatsApp media, logos) go to R2 instead of the server's disk. Old files are still read from the disk until the copy is done. Every Sunday at 2:30 in India, an encrypted copy of the database goes to a separate R2 bucket.

## I. R2 buckets and a key (Cloudflare)

1. Cloudflare dashboard → **R2 Object Storage**. The first time, Cloudflare may ask for a payment method. R2's free monthly allowance (about 10 GB) should cover this CRM for now (unverified: check Cloudflare's R2 pricing page).
2. **Create bucket** three times. Keep each one private (no public access):

   | Bucket | For |
   |---|---|
   | `yellow-crm-files` | production's files |
   | `yellow-crm-files-staging` | staging's files |
   | `yellow-crm-backups` | the weekly database copies |

3. **R2 → Manage API tokens** → **Create API token** → permission **Object Read & Write** → apply to the three buckets → **Create**.
4. Cloudflare shows the **Access Key ID** and the **Secret Access Key** once. Keep them in your password manager.
5. Copy your **Account ID** from the R2 overview page.

## J. Render: switch the files to R2

1. **yellow-crm** (production) → **Environment** → add these, then **Save**:

   | Key | Value |
   |---|---|
   | `STORAGE_DRIVER` | `r2` |
   | `R2_ACCOUNT_ID` | your Account ID |
   | `R2_ACCESS_KEY_ID` | the Access Key ID |
   | `R2_SECRET_ACCESS_KEY` | the Secret Access Key |
   | `R2_BUCKET` | `yellow-crm-files` |
   | `R2_BACKUP_BUCKET` | `yellow-crm-backups` |

2. **yellow-crm-staging** → **Environment**: the same, but `R2_BUCKET` = `yellow-crm-files-staging`, and **no** `R2_BACKUP_BUCKET` (staging's data is made up).
3. Render deploys both. New uploads now go to R2; old ones are read from the disk until step K.

## K. Copy the old files (production, once)

1. Render → **yellow-crm** → **Shell**.
2. Type:

   ```bash
   cd backend && node scripts/files-to-r2.js
   ```

3. It ends with a line like `120 files: 0 already in R2, 120 copied, 0 missing, 0 failed`.
4. Then check, which changes nothing:

   ```bash
   cd backend && node scripts/files-to-r2.js --check
   ```

   It must say **0 missing, 0 failed**.

The disk stays as it is. It is removed in week 3, when the CRM moves to two servers.

## L. The backup copy (production)

In the same **Shell**:
1. Make the first copy now (the job then makes one every Sunday):

   ```bash
   cd backend && node scripts/backup.js run
   ```

2. Read it back, which downloads, decrypts and counts every collection:

   ```bash
   cd backend && node scripts/backup.js check
   ```

   It must say **OK**.
3. `node scripts/backup.js list` shows the copies; the newest 8 are kept.

**Important:** the copies are encrypted with a key made from `DATA_ENCRYPTION_KEY`. Without it they cannot be read. Make sure that value from Render's Environment tab is in your password manager.

## M. Check that week 2 works

| Check | How | Expected |
|---|---|---|
| New uploads on R2 | Upload a document on staging; Cloudflare → `yellow-crm-files-staging` → **Objects** | A file under `documents/` |
| Old files still open | Production: open a document uploaded before the switch | It downloads |
| Copy complete | `node scripts/files-to-r2.js --check` | 0 missing, 0 failed |
| Logo | Settings → company logo shows; a quotation PDF shows the logo | Same as before |
| Backup readable | `node scripts/backup.js check` | OK |

Tell me what you saw (not the keys), and we go on to week 3 (two servers).

---

# Week 3: two servers (F6)

The CRM can now run on more than one server at once:
- the live inbox reaches every browser, whichever server it is connected to;
- the sign-in limits count together;
- the data migrations run once;
- a WhatsApp message is handled by one server only.

Staging moves to two servers first. Production follows only after your file copy (section K) shows nothing missing.

## N. Staging on two servers

1. Push the week 3 commit to `staging`:

   ```bash
   git push origin main:staging
   ```

2. Render → **Blueprints** → sync. **yellow-crm-staging** now shows **2 instances**. This adds about $7 a month (unverified; check Render's pricing).
3. Open `https://<staging address>/api/v1/health` a few times. The `instance` value changes between the two servers.
4. On staging:
   - **Settings → WhatsApp**: add a test number, if there is none;
   - open **Inbox** in a second browser window;
   - in **Settings → WhatsApp**, send a message with the message simulator.

   It appears in the Inbox window at once, whichever server each window is connected to.

## O. Production on two servers (after section K)

**Only when `node scripts/files-to-r2.js --check` says 0 missing, 0 failed.** Removing the disk deletes the files on it; R2 has the copies by then.

1. Tell me "copy check is 0 missing". I then make one small commit for `render.yaml`: production without the disk, on 2 instances.
2. Before you push that commit, set `STORAGE_DISK_FALLBACK` = `off` on **yellow-crm**: nothing is read from the disk any more.
3. Push. Render moves production to two servers.
4. Check `/api/v1/health` and the Inbox as in section N.

## P. Good to know

- If a browser cannot use WebSockets (some office networks block them), the live inbox falls back to slower requests. Those may not work across two servers: Render does not keep a browser on one server. The Inbox still works; it just is not live there.
- The general API limit (300 requests a minute) is counted by each server separately, so with two servers someone can make up to 600. The sign-in and company-name limits are counted together.

Tell me what you saw, and we go on to week 4 (2FA and the restore drill).

---

# Week 4: 2-step login with an authenticator app, and the restore drill (F7, F4b)

## Q. Turn on 2-step login (everyone, and owners and admins must)

1. Install **Google Authenticator** (or Microsoft Authenticator) on your phone.
2. In the CRM: **Settings → Your Profile → 2-step login → Set up 2-step login**. You can also use the yellow band shown to owners and admins.
3. In the app, scan the QR code (or type the key shown under it). Enter the 6-digit code the app shows → **Turn on 2-step login**.
4. The CRM shows **10 backup codes** once. **Download** them (or copy them) and keep them somewhere safe that is **not** your phone: a password manager, or printed. Each code logs you in once if the phone is lost.
5. From now on, after Google, the CRM asks for the app's code. "Stay logged in on this browser" skips it on that browser for 30 days.

**Owners and admins must use it:**
- From the day they are first seen after this update, they get **7 days** (the yellow band says by when).
- After that, the CRM opens only the 2-step login page until they turn it on.
- They cannot turn it off themselves; they can only make new backup codes.

## R. When someone loses their phone

- **They have a backup code:** they log in with it (on the login page, "Use a backup code"), then on the 2-step login page they make new backup codes. When they have a new phone, an owner or admin resets it (below) so they can set it up again.
- **Another owner or admin can reset it:** **Settings → Team & Access** → the shield button next to the person → confirm. Do this only when you are sure it is really them, for example by calling the number you already know.
  - They are told on the bell.
  - They log in with Google alone until they set it up again.
  - An owner or admin among them gets a fresh 7 days.
- **Only support can reset it** (you, on Render) when the person is the only owner, or belongs to other companies too:
  1. Check who is asking.
  2. Render → **yellow-crm** → **Shell**.
  3. Type the command below. It is written to the audit log of each of their companies.

  ```bash
  cd backend && node scripts/totp-reset.js their@email.com --yes
  ```

## S. The restore drill (once a month)

This proves the weekly copy (section L) can really be put back. It never touches production's database.

Since Phase 8 (D120) the CRM does it by itself every 4 weeks — into a separate database on the same
cluster, counted and dropped — and the platform admin page → **Backups** shows each result and runs
one on demand (docs/DATA_TRUST.md). The steps below are the full drill into another cluster, for a
real disaster; after such a restore, also run `node scripts/backup.js reapply-erasures <day>`.

1. **A temporary database:** Atlas → your staging project (or a new one) → **Create** a new **M0** cluster named `restore-drill` → a database user → **Network Access** as before → **Connect → Drivers** → copy its address.
2. Render → **yellow-crm** → **Shell**. List the copies:

   ```bash
   cd backend && node scripts/backup.js list
   ```

3. Restore the newest one into the temporary database. Use that day and the address from step 1, in quotes:

   ```bash
   cd backend && node scripts/backup.js restore 2026-11-01 "mongodb+srv://…restore-drill…"
   ```

   It refuses production's own address and any database that is not empty. It ends with `OK, N collections, M documents in S seconds`.
4. Write down the date, the line it printed and how long it took (the goal is under an hour, all of it).
5. **Delete** the `restore-drill` cluster in Atlas: it holds a copy of your customers' data.

## T. Check that week 4 works

| Check | How | Expected |
|---|---|---|
| Set up | Staging: Your Profile → Set up 2-step login | QR code, then 10 backup codes |
| Asked after Google | Log out, log in again | "Enter the code from your authenticator app" |
| Backup code | "Use a backup code" on the login page | Logs in once; the same code a second time is refused |
| Owners required | An owner without it, after 7 days | Only the 2-step login page opens |
| Reset | Team & Access → shield button | The person logs in with Google alone and sees a bell note |
| Restore drill | Section S | OK, counts match, under an hour |

That completes the 30-day foundation. The last step left is production on two servers (section O), after your copy check.

