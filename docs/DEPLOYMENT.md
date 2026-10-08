# Production deployment (Phase 10F)

How to run YELLOW CRM for real customers: on an HTTPS domain, with MongoDB Atlas, kept running, backed up and monitored. Hosting is still decision **D18**; this guide works for a small cloud server (a VPS) and for a platform such as Render, Railway or Fly.io.

## 1. What runs

- **One Node.js process** (`node src/server.js` in `backend/`, Node 24). It serves:
  - the pages (`/crm/frontend`);
  - the API (`/api/v1`) and the public API (`/api/public/v1`);
  - webhooks (`/api/v1/webhooks/...`);
  - Socket.IO (the live inbox);
  - the background jobs (lead pulls, broadcasts, payments, billing, AI replies, push).

  The jobs run from MongoDB itself, not Redis. **Redis is not needed.**
- **MongoDB Atlas** as a **replica set** (every Atlas cluster is one). Transactions need it.
  - Use **M10 or bigger** for real traffic (D19). The free tier is for trials.
- **Two folders** that must survive restarts and be backed up:
  - `UPLOAD_DIR`: company logos;
  - `DOCUMENT_DIR`: documents, WhatsApp media and quotation PDFs, one folder per company.

  On a platform with temporary disks, mount a **persistent volume** for both.

Run **one instance** for now. Socket.IO's live updates and the in-process job worker assume a single process; scaling out needs a Socket.IO adapter, which is not built yet.

## 2. Domain and HTTPS

Webhooks (Meta, Razorpay, Cashfree, Facebook, IndiaMART push), Google sign-in, web push and the installable app all need **HTTPS on a real domain**, for example `https://crm.yourcompany.in`.

### On a VPS

Use nginx (or Caddy) in front of Node, with a Let's Encrypt certificate.

```nginx
server {
  listen 443 ssl http2;
  server_name crm.yourcompany.in;
  # ssl_certificate / ssl_certificate_key: from certbot
  client_max_body_size 30m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # Socket.IO
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
  }
}
```

With a proxy in front, set `TRUST_PROXY=1`. This lets the CRM see the real client address (rate limits, audit log) and know the request was https (secure cookies).

### On a platform

Point the domain at the service, turn on its managed certificate, and set `TRUST_PROXY=1` (most platforms have one proxy).

## 3. Settings (`backend/.env` on the server)

Start from `backend/.env.example`.

**Required:**

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | e.g. `3000` |
| `PUBLIC_URL` | `https://crm.yourcompany.in` (no trailing slash) |
| `MONGO_URI` | your Atlas connection string, `mongodb+srv://...` |
| `JWT_SECRET` | 32+ random characters |
| `DATA_ENCRYPTION_KEY` | 32+ random characters; encrypts tokens, keys and secrets. **Never change it once data exists** |
| `GOOGLE_CLIENT_ID` | from Google Cloud |
| `GOOGLE_CLIENT_SECRET` | from Google Cloud |
| `TRUST_PROXY` | `1` |

**Optional, by feature:**

- WhatsApp: `WHATSAPP_GRAPH_VERSION`
- Plan billing: `BILLING_PROVIDER`, `RAZORPAY_BILLING_*`, `BILLING_SELLER_*`
- AI assistant: `ANTHROPIC_API_KEY`, `AI_*`
- Web push: `VAPID_*`
- Login codes on WhatsApp (D58): `OTP_PROVIDER`, `WHATSAPP_OTP_*`, `LOGIN_WHATSAPP_CODE`
- Login codes by SMS, the backup (D59): `SMS_PROVIDER`, `MSG91_*`
- Rate limits: `RATE_LIMIT_*`
- Company deletion: `ORG_DELETION_GRACE_DAYS`

**In production these are always off:** the test gateway, test WhatsApp numbers, the test billing page and the simulator. `BILLING_PROVIDER` and `OTP_PROVIDER` default to `off` until you set them.

Keep `.env` out of git (it already is). Make a random value with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 4. Google sign-in

In Google Cloud Console → **APIs & Services → Credentials** → your OAuth client:

1. Add `https://crm.yourcompany.in` to **Authorized JavaScript origins**.
2. Add `https://crm.yourcompany.in/api/v1/gmail/oauth/callback` to **Authorized redirect URIs** (for Gmail).

## 5. Keep it running

### With PM2 on a VPS

```bash
cd backend && npm ci --omit=dev
npx pm2 start src/server.js --name yellow-crm --time
npx pm2 save && npx pm2 startup      # start again after a reboot
npx pm2 install pm2-logrotate        # log rotation (10 MB × 10 files by default)
```

`npx` downloads PM2 the first time. A systemd service works just as well if you prefer it.

### On a platform

- **Start command:** `node src/server.js`
- **Root:** `backend/`
- **Health check:** `GET /api/v1/health`, which answers with `dbState` (1 = connected).

### Updating the CRM

1. `git pull`
2. `npm ci --omit=dev`
3. Restart the process.

Data migrations run by themselves at start. Each runs once and is safe to repeat. New indexes are built by MongoDB. Take a backup first (section 7).

## 6. After the first start: webhooks and keys

Register these addresses, all on the new domain:

- **WhatsApp:** each number's callback URL is shown in Settings → WhatsApp.
- **Lead sources:** IndiaMART push, Facebook, Google Ads, JustDial, TradeIndia, in Settings → Lead sources.
- **Payment gateways:** each company's own, in Settings → Payments.
- **Plan billing:** `https://<domain>/api/v1/webhooks/billing/razorpay` (see docs/BILLING_SETUP.md).

Then switch the optional features on: AI (docs/AI_ASSISTANT.md), phone sign-in (docs/WHATSAPP_SETUP.md), plan billing (docs/BILLING_SETUP.md).

## 7. Backups

- **Database:** turn on Atlas **Cloud Backup** (continuous or daily snapshots) and test a restore once.
- **Files:** copy `UPLOAD_DIR` and `DOCUMENT_DIR` every night to another place, for example `rclone` or `aws s3 sync` to an S3 or R2 bucket. Keep 30 days.
- **Settings:** keep a copy of `.env` in a password manager. Without `DATA_ENCRYPTION_KEY`, the stored tokens and keys cannot be read.
- **Each company's own copy:** Settings → Data & Privacy → **Download CRM data** (one JSON file of everything except secrets).

## 8. Logs and monitoring

- The server logs to stdout as JSON lines (winston): requests (paths only, no tokens), warnings and errors. PM2 or the platform keeps them; rotate them (section 5).
- Watch `GET /api/v1/health` from an uptime monitor (UptimeRobot, Better Stack), every minute.
- **Audit log:** owners and admins see who did what in **Settings → Audit log**.
- **The platform owner:**
  - `node scripts/plan.js list` shows every company, its plan and state;
  - `comp`, `trial` and `set` change them (see the top of the script).

## 9. Security checklist

- [ ] HTTPS only. The secure refresh cookie needs it.
- [ ] `NODE_ENV=production`, so test pages and simulators are off.
- [ ] Strong `JWT_SECRET` and `DATA_ENCRYPTION_KEY`, never committed.
- [ ] Atlas network access limited to the server's address; a database user with access to this database only.
- [ ] `CORS_ORIGINS` only if the pages are served from another domain.
- [ ] Rate limits left on (defaults).
- [ ] Backups tested (section 7).
- [ ] Run `npm audit` and update dependencies before launch, and monthly after.

## 10. Companies that leave

An owner can delete the company in **Settings → Data & Privacy**:

- It keeps working for `ORG_DELETION_GRACE_DAYS` (7 days), and any owner can cancel during that time.
- After that, every record of the company and its files are removed, and its paid plan stops.
- The platform's GST invoices to the company are kept (tax law), and so are people's sign-in accounts.

Under India's DPDP Act, mention this in your terms and privacy notice.
