# Going live on Render (D18)

The CRM runs on **Render** as one web service, built from GitHub (`sureshkumawatindia-rgb/RealCrm`, branch `main`). The database stays on **MongoDB Atlas**. The settings live in `render.yaml` at the top of the repository. General background is in [DEPLOYMENT.md](DEPLOYMENT.md).

**What it costs:**

- The web service, plan `1c-2g`, plus a 5 GB disk. See Render's pricing page for today's prices.
- A paid Atlas tier (M10 or bigger) for real traffic (D19).

## Before you start

You need:

1. A Render account (render.com → Sign up with GitHub), with a card added for the paid instance.
2. Your `backend/.env` open in Notepad. You will copy five values from it. **Never paste them anywhere except Render.**

## Step 1: let Render reach Atlas

In Atlas, open **Network Access** → **Add IP Address** → **Allow access from anywhere** (`0.0.0.0/0`) → Confirm.

Render's addresses change. A strong database password is the protection here. Later you can switch to Render's fixed outbound addresses: Render dashboard → your service → **Connect** → **Outbound**.

## Step 2: create the service from the Blueprint

1. Render dashboard → **New** → **Blueprint**.
2. Connect GitHub, pick **RealCrm**, branch **main**. Render reads `render.yaml` and shows the **yellow-crm** web service with a 5 GB disk.
3. Render asks for the values marked "sync: false". Fill them in:

   | Key | Value |
   |---|---|
   | `MONGO_URI` | copy from `backend/.env` |
   | `JWT_SECRET` | copy from `backend/.env`. The same value keeps customers' quotation links working |
   | `GMAIL_TOKEN_ENCRYPTION_KEY` | copy from `backend/.env`. The same value keeps the saved WhatsApp, Gmail and gateway tokens readable |
   | `GOOGLE_CLIENT_ID` | copy from `backend/.env` |
   | `GOOGLE_CLIENT_SECRET` | copy from `backend/.env` |
   | `PUBLIC_URL` | `https://yellow-crm.onrender.com` (Render shows the exact address; if the name is taken it adds letters) |

   `DATA_ENCRYPTION_KEY` is made by Render: leave it. **Never change it later.**
4. Press **Apply**. The first build takes a few minutes. When it is done, **Logs** shows `Server running in production mode`, and `https://<your address>/api/v1/health` answers `"dbState":1`.

## Step 3: Google sign-in on the new address

Google Cloud Console → **APIs & Services → Credentials** → your OAuth client:

1. Under **Authorized JavaScript origins**, add `https://yellow-crm.onrender.com` (your address).
2. Under **Authorized redirect URIs**, add `https://yellow-crm.onrender.com/api/v1/gmail/oauth/callback`.
3. Save.

Then open `https://<your address>/crm/frontend/login.html` and sign in.

## Step 4: stop the computer's server from using the same database

The CRM on this computer and the one on Render must not both run against the **same Atlas database**. Both would run the background jobs: sending broadcasts, pulling IndiaMART, answering chats.

After Render works, either stop using `start-crm.vbs` for the live data, or point the computer's `backend/.env` `MONGO_URI` at a separate test database.

## Step 5: point the outside services at the new address

Each address is shown in the CRM settings. Settings → WhatsApp and Settings → Lead sources show them on the new domain.

- **Meta (WhatsApp):** in each number's webhook settings, set the callback URL to the new one shown in Settings → WhatsApp.
- **IndiaMART push, Facebook Lead Ads, Google Ads, JustDial, TradeIndia:** the new addresses from Settings → Lead sources.
- **Each company's Razorpay or Cashfree:** the webhook address from Settings → Payments.
- **Plan billing:** see [BILLING_SETUP.md](BILLING_SETUP.md).

## Step 6 (optional): your own domain

1. Render → your service → **Settings** → **Custom Domains** → add `crm.yourcompany.in`.
2. Add the DNS record Render shows at your domain seller. Render issues the HTTPS certificate itself.
3. Change `PUBLIC_URL` to the new domain, and add it in Google (step 3) and the webhooks (step 5).

## Step 7: switch on the optional features

These are environment variables on Render (service → **Environment**). Saving them redeploys the service.

| Feature | Variables | Guide |
|---|---|---|
| Plan billing | `BILLING_PROVIDER=razorpay`, `RAZORPAY_BILLING_*`, `BILLING_SELLER_*` | [BILLING_SETUP.md](BILLING_SETUP.md) |
| Sign-in codes on WhatsApp | `OTP_PROVIDER=whatsapp`, `WHATSAPP_OTP_*` | [WHATSAPP_SETUP.md](WHATSAPP_SETUP.md) |
| AI assistant | `ANTHROPIC_API_KEY`, `AI_*` | [AI_ASSISTANT.md](AI_ASSISTANT.md) |
| Web push (fixed keys) | `VAPID_SUBJECT=https://<your address>` | — (keys are made by themselves) |

## Updating

Every push to `main` on GitHub deploys by itself. Render builds, restarts, and runs any new data migration once.

With a disk, a deploy has a short pause of a few seconds while the old instance stops.

## Backups

- **Database:** turn on Atlas Cloud Backup.
- **Disk:** Render keeps daily snapshots of the disk (service → **Disks**).
- **Settings:** keep `backend/.env` and the Render environment values in a password manager.

## If something goes wrong

| Symptom | Fix |
|---|---|
| The build fails with "Invalid environment configuration" | A value from step 2 is missing; the log names the key, never its value. |
| `dbState` is not 1 | Check Atlas Network Access (step 1) and `MONGO_URI`. |
| Google says `origin_mismatch` | Step 3. |
| WhatsApp messages do not arrive | The Meta callback URL still points at the old address (step 5). |
| Saved WhatsApp or gateway tokens "cannot be read" | `GMAIL_TOKEN_ENCRYPTION_KEY` is not the same as on the computer. |
