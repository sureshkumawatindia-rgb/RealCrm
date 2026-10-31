# Go-live checklist: what only you can do

Everything the code needs is built. What is left are accounts, keys, domains and approvals that
only the business owner can do. Each task below says what to do, where the full steps are, and
what does not work without it. The same list, with which keys this server already has (never
their values), is on **Platform admin → Go-live checklist** (section 15 sets it up).

Secrets (keys, tokens, passwords) go only into `backend/.env` on your computer and into the
service's **Environment** on Render — never into a chat, an email or a document. After changing
`backend/.env`: keep a copy first, edit, save, restart the backend.

## 1. The server on Render (production settings)

- **Do:** create the production service and set its variables: `NODE_ENV=production`, `PUBLIC_URL`
  (your https address), `MONGO_URI`, `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID`,
  `TRUST_PROXY=1`.
- **Guide:** `docs/RENDER_SETUP.md` (steps 1–5), `docs/DEPLOYMENT.md` §3.
- **Without it:** the CRM only runs on your computer.

## 2. Your own domain with HTTPS

- **Do:** point `crm.yourdomain.in` (or similar) at Render and set `PUBLIC_URL` to it.
- **Guide:** `docs/RENDER_SETUP.md` step 6, `docs/DEPLOYMENT.md` §2.
- **Without it:** customers see an onrender.com address; "Connect WhatsApp" and Google need the
  final address in their settings.

## 3. MongoDB Atlas on a paid tier, with backups

- **Do:** move the production cluster to a paid tier (M10 or above) with cloud backups on.
- **Guide:** `docs/DEPLOYMENT.md` §7, `docs/FOUNDATION_SETUP_STEPS.md` section B.
- **Without it:** the free tier stops at 512 MB and has no backups.

## 4. Files on Cloudflare R2, and the weekly backup copy

- **Do:** create the R2 buckets and key, set `STORAGE_DRIVER=r2` and the `R2_*` keys, copy the old
  files once, and set `R2_BACKUP_BUCKET`.
- **Guide:** `docs/FOUNDATION_SETUP_STEPS.md` sections I–L.
- **Without it:** files stay on one server's disk (a second server cannot run) and there is no
  weekly copy of the database outside Atlas.

## 5. Error reports and the "site is down" email

- **Do:** Sentry (`SENTRY_DSN`) and UptimeRobot.
- **Guide:** `docs/FOUNDATION_SETUP_STEPS.md` sections E–G.
- **Without it:** errors are only in the server log; nobody hears when the site is down.

## 6. Google sign-in for your domain

- **Do:** in Google Cloud, add the production address to the OAuth client, set
  `GOOGLE_CLIENT_SECRET`, and publish the consent screen (Google verifies apps that read Gmail or
  Calendar).
- **Guide:** `docs/DEPLOYMENT.md` §4, `docs/RENDER_SETUP.md` step 3.
- **Without it:** nobody can sign in on the new address; Gmail, Calendar and Drive cannot connect.

## 7. Meta: business verification, Tech Provider and App Review

- **Do:** verify the business in Meta Business Manager, set up "Connect WhatsApp" (Embedded Signup:
  `META_APP_ID`, `META_APP_SECRET`, `META_ES_CONFIG_ID`, `META_WEBHOOK_VERIFY_TOKEN`), pass App
  Review, switch the app to Live.
- **Guide:** `docs/WHATSAPP_SETUP.md` part A.
- **Without it:** companies cannot connect WhatsApp with Meta's popup (only by hand on their own
  Meta app); Meta's limits stay low.

## 8. Razorpay Subscriptions for the plans

- **Do:** live keys (`RAZORPAY_BILLING_KEY_ID` = `rzp_live_…`, `RAZORPAY_BILLING_KEY_SECRET`), the
  webhook and its secret (`RAZORPAY_BILLING_WEBHOOK_SECRET`), `BILLING_PROVIDER=razorpay`.
- **Guide:** `docs/BILLING_SETUP.md` sections 2, 3 and 5.
- **Without it:** companies cannot buy a plan online; when a trial ends they can only write to you.

## 9. Your legal details

- **Do:** the company's legal name, address, email and GSTIN on the plan invoices
  (`BILLING_SELLER_NAME`, `BILLING_SELLER_GSTIN`, `BILLING_SELLER_ADDRESS`, `BILLING_SELLER_EMAIL`;
  confirm the SAC with your CA), and the same details for the website's terms, privacy and
  data-deletion pages (polish plan checkpoint 2 — send them when ready).
- **Guide:** `docs/BILLING_SETUP.md` section 4.
- **Without it:** the GST invoices to companies miss the seller's details; Meta's App Review asks
  for the privacy and data-deletion pages.

## 10. Payment links of each company (Razorpay or Cashfree)

- **Do:** nothing on the server — each company adds its own live keys and webhook in
  Settings → Payments. Tell new companies about it.
- **Guide:** `docs/PAYMENTS_SETUP.md`.
- **Without it:** that company's payment links stay in test mode.

## 11. SMS backup for login codes (MSG91 with DLT)

- **Do:** DLT registration (a few days), MSG91 template and key, `SMS_PROVIDER=msg91`.
- **Guide:** `docs/SMS_SETUP.md`.
- **Without it:** login codes go only on WhatsApp. Optional.

## 12. WhatsApp login codes from the platform's own number

- **Do:** an approved Authentication template on the platform's number
  (`WHATSAPP_OTP_*`, `OTP_PROVIDER=whatsapp`).
- **Guide:** `docs/WHATSAPP_SETUP.md`, "Login codes on WhatsApp".
- **Without it:** 2-step verification by WhatsApp code is off (the authenticator app still works).

## 13. Emails from your domain (Resend)

- **Do:** a Resend account, the sending domain's SPF, DKIM and DMARC records, a sending key,
  `RESEND_API_KEY` and `EMAIL_FROM`.
- **Guide:** `docs/EMAIL_SETUP.md`.
- **Without it:** no invite, trial, payment, invoice, deletion or new-login emails (the bell and the
  invite links still work).

## 14. The AI assistant (optional)

- **Do:** an Anthropic API key with a monthly spending limit in its console, `ANTHROPIC_API_KEY`
  and `AI_MONTHLY_BUDGET_USD`.
- **Guide:** `docs/AI_ASSISTANT.md`.
- **Without it:** the AI assistant is not offered.

## 15. The platform admin page

- **Do:**
  1. Turn on 2-step login with an authenticator app on your own account (Settings → Your
     profile → 2-step login).
  2. Put your Google email in `PLATFORM_ADMIN_EMAILS` (more than one: separated by commas) and
     restart.
  3. Open **Platform admin** in the menu (under Settings) and enter a code from the app. It stays
     open on that device for 30 minutes.
- **What it shows:** every company as counts (plan, trial end, users, WhatsApp numbers and their
  health, contacts, broadcasts this month, last active, what it paid) — never its customers,
  chats or files, and no signing in as a company; MRR, money in this month, new companies, trial
  to paid and churn; the platform's emails; this checklist. Comp a company, give a trial or change
  a plan (each written to that company's audit log).
- **Without it:** you can still use `node scripts/plan.js` on the server.

## 16. 2-step login for owners and admins

- **Do:** every owner and admin turns on the authenticator app within 7 days (the CRM asks them).
- **Guide:** `docs/FOUNDATION_SETUP_STEPS.md` sections Q–R.
- **Without it:** after the grace days, owners and admins are sent to the set-up page.

When every item shows **Done** (or "Check by hand" items are done in their own consoles), the CRM
is ready for paying customers.
