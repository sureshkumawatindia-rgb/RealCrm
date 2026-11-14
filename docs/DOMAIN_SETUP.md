# Domain setup: agreem360 on crm.agreem360.com

How to put the CRM on its own address, step by step. It fills in **GO_LIVE_CHECKLIST step 2**
and gets steps 6, 7, 8 and 13 ready.

The domain is **agreem360.com** (D141, 2026-11-11). Since D150 (2026-11-14) the name people read
everywhere is **agreem360** too (AgreemCRM before). It replaces the earlier agreemcrm.com plan (D121).

## The plan (decide once, never change)

| Address | What it does |
|---|---|
| **`https://crm.agreem360.com`** | **The CRM.** This becomes `PUBLIC_URL`. Google, Meta, Razorpay and every company's webhooks point here. Its home page (`/`) is the public website. |
| `agreem360.com`, `www.agreem360.com` | For now they send people to the CRM address, keeping the page asked for (`agreem360.com/crm/frontend/privacy.html` opens the privacy page). Later, a separate website can live here without touching the CRM. |
| `mail.agreem360.com` | Sends the CRM's emails (Resend, `docs/EMAIL_SETUP.md`). |
| `staging.agreem360.com` | Optional: the staging server. |

**Why `crm.` and not the plain domain:** after go-live, the CRM address is pasted in Google, Meta,
Razorpay and in each company's own IndiaMART, Facebook and payment settings. Changing it later
means asking every company to paste it again. `crm.agreem360.com` can stay forever, even when a
real website comes to `agreem360.com`.

**No code changes are needed.** Everything follows `PUBLIC_URL`: the webhook addresses shown in
Settings, Google sign-in, CORS, `robots.txt`, `sitemap.xml` and the go-live checklist. The
computer's `backend/.env` keeps `PUBLIC_URL=http://127.0.0.1:3000`. Only Render gets the new
address. (One thing names the domain itself: the picture WhatsApp and Facebook show when the home
page or the login page is shared needs a full address, so `index.html` and `login.html` say
`https://crm.agreem360.com/…` there.)

---

## The quick route: the DNS stays at GoDaddy (chosen 2026-11-11)

agreem360.com's DNS is at GoDaddy (nameservers `ns49/ns50.domaincontrol.com`). For the launch it
stays there: no nameserver change and no waiting. So **skip step 2 and step 5** (they are the
Cloudflare route, for later), and do steps 1, 3, 4, 6 and 7 with these changes:

**G1. The `crm` record (in place of step 3.3).** GoDaddy → **My Products** → `agreem360.com` →
**DNS** → **Add New Record**:
- Type: **CNAME**
- Name: `crm`
- Value: the address Render shows in step 3.2 (like `yellow-crm.onrender.com`; no `https://`,
  no `/`)
- TTL: leave the default → **Save**

Do not delete or change GoDaddy's other records (`@`, `www`, MX, `_domainconnect`).

**G2. Send agreem360.com to the CRM (in place of step 5).** GoDaddy → `agreem360.com` → **DNS** →
**Forwarding** → **Add Forwarding** for the domain:
- Forward to: `https://` and `crm.agreem360.com`
- Redirect type: **Permanent (301)**
- **Forward only** (never "Forward with masking": it hides the CRM in a frame, and the CRM
  refuses frames)
- **Save.** GoDaddy sets the `@` records itself; leave them as it sets them. `www` points at `@`
  by default, so it follows.

GoDaddy sends every page to the CRM's home page (it does not keep the page asked for), which is
fine for now. If `https://agreem360.com` (with the "s") shows a certificate warning, GoDaddy's
forwarding has no certificate for it; moving the DNS to Cloudflare later (steps 2 and 5) fixes
that. Nobody pastes the root address anywhere, so this can wait.

**G2b. agreem360.com opens agreem360's own website (D149).** The website is ready at
`https://crm.agreem360.com/crm/frontend/agreem360.html`. In G2, put that whole address in
**Forward to** (`https://` and `crm.agreem360.com/crm/frontend/agreem360.html`), **Permanent (301)**,
**Forward only**, **Save**. When the DNS later moves to Cloudflare (or `agreem360.com` is added to
the Render service itself), point `@` and `www` at the same server instead: the server opens the
website for `agreem360.com` and `www.agreem360.com` by itself (`SITE_HOSTS`, nothing to set) and
the CRM's home page for `crm.agreem360.com`.

**G3. Email records (step 7).** Add Resend's records in GoDaddy's DNS the same way. GoDaddy adds
`.agreem360.com` to the name itself: for a record Resend shows as `send.mail.agreem360.com`, type
`send.mail` as the Name.

---

## Step 1: the domain's own settings (5 minutes)

agreem360.com is already bought. In the domain seller's account, check:

- **Auto-renew: ON**
- **Domain lock / Transfer lock: ON**
- **Privacy protection: ON** (usually free)
- **2-step login (2FA): ON** for the seller account itself
- **DNSSEC: OFF** for now (only matters for the Cloudflare route: step 2 moves the DNS, and
  DNSSEC would block it)

Do not buy the extras the seller offers (hosting, email, SSL certificate, website builder).
Render and Cloudflare give HTTPS free. Email comes from Resend, and Zoho or Google later.

## Step 2 (Cloudflare route, later): move the DNS to Cloudflare (free, 10 minutes + waiting)

Skip this step while the DNS stays at GoDaddy (the quick route above).

One place for all records, free HTTPS redirects, and the R2 account is already there.

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Add a domain** → `agreem360.com` →
   plan **Free** → continue. Cloudflare shows **two nameservers** (like `xxx.ns.cloudflare.com`).
2. At the domain seller: `agreem360.com` → **Nameservers** → **Change** → **Custom** → paste
   Cloudflare's two nameservers → save.
3. Wait until Cloudflare shows the domain as **Active**. Often within an hour, at most 24 hours.
   Cloudflare emails you.

> **The rule for every record that points at Render or Resend:** set Proxy status to
> **DNS only (grey cloud)**. Only the redirect records in step 5 are **Proxied (orange)**.

## Step 3: the CRM on `crm.agreem360.com` (20 minutes)

If the Render service is not made yet, first do `docs/RENDER_SETUP.md` steps 1–5 (with the
onrender.com address). Then:

1. Render → service **yellow-crm** → **Settings** → **Custom Domains** → **Add** →
   `crm.agreem360.com`.
2. Render shows a **CNAME** record (name `crm`, value like `yellow-crm.onrender.com`).
3. With the DNS at GoDaddy: add the record as in **G1** above. On the Cloudflare route instead:
   Cloudflare → `agreem360.com` → **DNS** → **Records** → **Add record**:
   - Type: **CNAME**
   - Name: `crm`
   - Target: exactly what Render showed
   - Proxy status: **DNS only (grey)**
4. Back in Render → **Verify**. Render issues the HTTPS certificate itself, usually within a few
   minutes.
5. Render → **Environment** → `PUBLIC_URL` = `https://crm.agreem360.com` (no `/` at the end) →
   **Save** (the service restarts).
6. Check:
   - `https://crm.agreem360.com/api/v1/health` answers `"dbState":1`
   - `https://crm.agreem360.com` opens the home page with the lock icon
   - `https://crm.agreem360.com/robots.txt` ends with `Sitemap: https://crm.agreem360.com/sitemap.xml`
   - **Platform admin → Go-live checklist**: "Your own domain with HTTPS" is done

The old onrender.com address keeps working too, so nothing breaks while you move the services
below one by one.

## Step 4: Google sign-in on the new address (5 minutes)

Google Cloud Console → **APIs & Services → Credentials** → the OAuth client:

1. **Authorized JavaScript origins** → add `https://crm.agreem360.com`
2. **Authorized redirect URIs** → add `https://crm.agreem360.com/api/v1/gmail/oauth/callback`
3. If Microsoft (Outlook) is connected in Azure, add its redirect there too:
   `https://crm.agreem360.com/api/v1/integrations/microsoft/callback`
4. **OAuth consent screen** → **Authorized domains** → add `agreem360.com`; set the home page,
   privacy and terms links to the addresses in step 6.
5. Save. Open `https://crm.agreem360.com/crm/frontend/login.html` and sign in with Google.

Keep the old onrender.com entries until everything works. They do no harm.

## Step 5 (Cloudflare route, later): send agreem360.com and www to the CRM (10 minutes)

While the DNS stays at GoDaddy, do **G2** above instead.

Cloudflare → `agreem360.com` → **DNS → Records**, add two records:

| Type | Name | IPv4 address | Proxy status |
|---|---|---|---|
| A | `@` | `192.0.2.1` | **Proxied (orange)** |
| A | `www` | `192.0.2.1` | **Proxied (orange)** |

`192.0.2.1` is a placeholder. Cloudflare answers these addresses with the redirect itself, so
nothing is ever sent to that address.

Then go to **Rules → Redirect Rules → Create rule**:
- Name: `to the CRM`
- **Custom filter expression**: Hostname **equals** `agreem360.com` **OR** Hostname **equals**
  `www.agreem360.com`
- Then: **Dynamic** → expression
  `concat("https://crm.agreem360.com", http.request.uri.path)` → status **301** →
  **Preserve query string** on → **Deploy**

Use the filter, not "All incoming requests", so `crm.`, `mail.` and `staging.` are never touched.
(If the Dynamic type is not offered, **Static** → URL `https://crm.agreem360.com` works too; it
only drops the page path.)

**Check:** `agreem360.com`, `www.agreem360.com` and `agreem360.com/crm/frontend/privacy.html` all
land on `https://crm.agreem360.com` (the last one on its privacy page) with the lock icon.

**Later, when a separate website is ready:** delete the rule and point `@` and `www` at the
website. The CRM stays on `crm.`.

## Step 6: the outside services (when each is set up)

Every address below is also shown inside the CRM on the new domain.

| Service | Address to paste | Guide |
|---|---|---|
| Meta: Connect WhatsApp webhook | `https://crm.agreem360.com/api/v1/webhooks/meta` | `WHATSAPP_SETUP.md` A3 |
| Meta: App domains / JavaScript SDK domains | `crm.agreem360.com` / `https://crm.agreem360.com/` | `WHATSAPP_SETUP.md` A3 |
| Meta: Privacy, Terms, data deletion | `https://crm.agreem360.com/crm/frontend/privacy.html`, `…/terms.html`, `…/privacy.html#data-deletion` | `WHATSAPP_SETUP.md` A3 |
| Meta: domain verification | Business settings → Brand safety → **Domains** → `agreem360.com` → add the **TXT** record Meta shows in the DNS (GoDaddy, or Cloudflare later) | `WHATSAPP_SETUP.md` A2 |
| Razorpay: website for the account's check | `https://crm.agreem360.com` (the home page links Terms, Privacy, Refund, Delivery and Contact) | `BILLING_SETUP.md` §2 |
| Razorpay plan billing webhook | `https://crm.agreem360.com/api/v1/webhooks/billing/razorpay` | `BILLING_SETUP.md` §3 |
| Lead sources (IndiaMART push, Facebook, Google Ads, JustDial, TradeIndia) | Settings → Lead sources shows each | `RENDER_SETUP.md` step 5 |
| Each company's Razorpay or Cashfree | Settings → Payments shows it | `PAYMENTS_SETUP.md` |
| Web push | Render → Environment: `VAPID_SUBJECT=https://crm.agreem360.com` | `RENDER_SETUP.md` step 7 |
| Google Search Console (optional) | Add the domain `agreem360.com` (a TXT record in the DNS), then submit `https://crm.agreem360.com/sitemap.xml` | — |

## Step 7: email on the domain

**Emails the CRM sends (invites, trials, invoices):** follow `docs/EMAIL_SETUP.md` with
`mail.agreem360.com`. Add Resend's TXT and MX records in the DNS (GoDaddy: see G3). On Cloudflare, set any CNAME
to **DNS only**. Then add the DMARC record (`_dmarc.mail.agreem360.com`). On Render:

```
EMAIL_FROM=agreem360 <hello@mail.agreem360.com>
```

`RESEND_API_KEY` goes only into Render's Environment, never into a chat.

**An inbox for people (support@, billing@, sales@):** Zoho Mail (it has a free plan for a few
users) or Google Workspace. Follow their "add domain" steps and add their MX, SPF and DKIM records
in the DNS of `agreem360.com`. This does not clash with Resend, because Resend uses
`mail.agreem360.com`. `BILLING_SELLER_EMAIL=billing@agreem360.com` needs this inbox to receive
mail; the support email in **Platform admin → Support** can be `support@agreem360.com`.

## Step 8 (optional): staging on `staging.agreem360.com`

The same as step 3, for the **yellow-crm-staging** service: custom domain
`staging.agreem360.com`, CNAME `staging` → the staging onrender.com address (**DNS only**), and
the staging service's `PUBLIC_URL=https://staging.agreem360.com`. Add it to Google's origins too.
Staging tells search engines to stay away by itself (`robots.txt` says `Disallow: /`).

---

## If something goes wrong

| Symptom | Fix |
|---|---|
| Cloudflare still says "Pending" after a day | The nameservers at the seller are not exactly Cloudflare's two, or DNSSEC is still on at the seller. |
| Render keeps "Verifying" / no certificate | GoDaddy: the `crm` record's value has `https://` or a `/` in it, or the record is only minutes old (wait up to an hour, press Verify again). Cloudflare: the `crm` CNAME is **Proxied (orange)**; set it to **DNS only (grey)**, then press Verify again. |
| `agreem360.com` opens the CRM inside a frame, or a blank page | GoDaddy's forwarding is set to "with masking". Change it to **Forward only** (G2). |
| "Too many redirects" | A Redirect Rule catches `crm.agreem360.com`. Use the hostname filter from step 5. |
| Google says `origin_mismatch` | Step 4: the origin is missing or has a `/` at the end. |
| WhatsApp messages stop arriving | Meta's callback still points at the old onrender.com address (step 6). |
| Resend says the domain is not verified | A record was added to `agreem360.com` instead of under `mail`, or a CNAME is Proxied. |
| A shared link shows no picture | WhatsApp keeps a link's card for a while; share the address with `?v=2` at the end once to see the new one. |
