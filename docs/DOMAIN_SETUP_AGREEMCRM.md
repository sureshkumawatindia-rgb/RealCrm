# Domain setup: agreemcrm.com and agreemcrm.in

How to put the CRM on its own address, step by step. It fills in **GO_LIVE_CHECKLIST step 2**
and gets steps 6, 7, 8 and 13 ready.

On 2026-11-08 both domains were still free (registry check). `agreem.com` and `agreem.in` already
belong to someone else.

## The plan (decide once, never change)

| Address | What it does |
|---|---|
| **`https://app.agreemcrm.com`** | **The CRM.** This becomes `PUBLIC_URL`. Google, Meta, Razorpay and every company's webhooks point here. |
| `agreemcrm.com`, `www.agreemcrm.com` | For now they send people to the CRM address. The CRM's own home page (`/`) is the website. Later, a separate website can live here without touching the CRM. |
| `agreemcrm.in`, `www.agreemcrm.in` | Send people to the CRM address. |
| `mail.agreemcrm.com` | Sends the CRM's emails (Resend, `docs/EMAIL_SETUP.md`). |
| `staging.agreemcrm.com` | Optional: the staging server. |

**Why `app.` and not the plain domain:** after go-live, the CRM address is pasted in Google, Meta,
Razorpay and in each company's own IndiaMART, Facebook and payment settings. Changing it later
means asking every company to paste it again. `app.agreemcrm.com` can stay forever, even when a
real website comes to `agreemcrm.com`.

**No code changes are needed.** Everything follows `PUBLIC_URL`: the webhook addresses shown in
Settings, Google sign-in, CORS and the go-live checklist. The computer's `backend/.env` keeps
`PUBLIC_URL=http://127.0.0.1:3000`. Only Render gets the new address.

---

## Step 1: buy the domains (15 minutes)

1. Use an adult's name (a parent's): name, email, phone and card. Domain sellers and Meta's
   business verification both need an adult owner. Later the domain can move to the company's
   name.
2. Use a seller such as GoDaddy, Hostinger, Namecheap or BigRock. Put **agreemcrm.com** and
   **agreemcrm.in** in one cart.
3. Choose **2 or 3 years**. Look at the **renewal price** too, not only the first-year offer.
4. **Do not add the extras** they offer: hosting, email, SSL certificate, website builder.
   Render and Cloudflare give HTTPS free. Email comes from Resend and Zoho or Google later.
5. After paying, in the seller's account:
   - **Auto-renew: ON** for both domains
   - **Domain lock / Transfer lock: ON**
   - **Privacy protection: ON** (usually free)
   - **2-step login (2FA): ON** for the seller account itself
   - **DNSSEC: OFF** for now (step 2 moves the DNS, and DNSSEC would block it)

## Step 2: move both domains' DNS to Cloudflare (free, 10 minutes + waiting)

One place for all records, free HTTPS redirects, and the R2 account is already there.

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Add a domain** → `agreemcrm.com` →
   plan **Free** → continue. Cloudflare shows **two nameservers** (like `xxx.ns.cloudflare.com`).
2. At the domain seller: `agreemcrm.com` → **Nameservers** → **Change** → **Custom** → paste
   Cloudflare's two nameservers → save.
3. Do the same for **`agreemcrm.in`**. Each domain may get a different pair of nameservers. Copy
   the pair Cloudflare shows for that domain.
4. Wait until Cloudflare shows the domain as **Active**. Often within an hour, at most 24 hours.
   Cloudflare emails you.

> **The rule for every record that points at Render or Resend:** set Proxy status to
> **DNS only (grey cloud)**. Only the redirect records in step 5 are **Proxied (orange)**.

## Step 3: the CRM on `app.agreemcrm.com` (20 minutes)

If the Render service is not made yet, first do `docs/RENDER_SETUP.md` steps 1–5 (with the
onrender.com address). Then:

1. Render → service **yellow-crm** → **Settings** → **Custom Domains** → **Add** →
   `app.agreemcrm.com`.
2. Render shows a **CNAME** record (name `app`, value like `yellow-crm.onrender.com`).
3. Cloudflare → `agreemcrm.com` → **DNS** → **Records** → **Add record**:
   - Type: **CNAME**
   - Name: `app`
   - Target: exactly what Render showed
   - Proxy status: **DNS only (grey)**
4. Back in Render → **Verify**. Render issues the HTTPS certificate itself, usually within a few
   minutes.
5. Render → **Environment** → `PUBLIC_URL` = `https://app.agreemcrm.com` (no `/` at the end) →
   **Save** (the service restarts).
6. Check:
   - `https://app.agreemcrm.com/api/v1/health` answers `"dbState":1`
   - `https://app.agreemcrm.com` opens the home page with the lock icon
   - **Platform admin → Go-live checklist**: "Your own domain with HTTPS" is done

## Step 4: Google sign-in on the new address (5 minutes)

Google Cloud Console → **APIs & Services → Credentials** → the OAuth client:

1. **Authorized JavaScript origins** → add `https://app.agreemcrm.com`
2. **Authorized redirect URIs** → add `https://app.agreemcrm.com/api/v1/gmail/oauth/callback`
3. If Microsoft (Outlook) is connected in Azure, add its redirect there too:
   `https://app.agreemcrm.com/api/v1/integrations/microsoft/callback`
4. Save. Open `https://app.agreemcrm.com/crm/frontend/login.html` and sign in with Google.

Keep the old onrender.com entries until everything works. They do no harm.

## Step 5: send the other addresses to the CRM (10 minutes)

**For `agreemcrm.com`:** Cloudflare → `agreemcrm.com` → **DNS → Records**, add two records:

| Type | Name | IPv4 address | Proxy status |
|---|---|---|---|
| A | `@` | `192.0.2.1` | **Proxied (orange)** |
| A | `www` | `192.0.2.1` | **Proxied (orange)** |

`192.0.2.1` is a placeholder. Cloudflare answers these addresses with the redirect itself, so
nothing is ever sent to that address.

Then go to **Rules → Redirect Rules → Create rule**:
- Name: `to the CRM`
- **Custom filter expression**: Hostname **equals** `agreemcrm.com` **OR** Hostname **equals**
  `www.agreemcrm.com`
- Then: **Static** → URL `https://app.agreemcrm.com` → status **301** → **Preserve query string**
  on → **Deploy**

Use the filter, not "All incoming requests", so `app.`, `mail.` and `staging.` are never touched.

**For `agreemcrm.in`:** the same two A records in the `agreemcrm.in` domain. In its Redirect
Rule, "All incoming requests" is fine here, with the same target `https://app.agreemcrm.com`.

**Check:** `agreemcrm.com`, `www.agreemcrm.com`, `agreemcrm.in` and `www.agreemcrm.in` all land
on `https://app.agreemcrm.com` with the lock icon.

**Later, when a separate website is ready:** delete the `agreemcrm.com` rule and point `@` and
`www` at the website. `.in` can then point at `https://agreemcrm.com`. The CRM stays on `app.`.

## Step 6: the outside services (when each is set up)

Every address below is also shown inside the CRM on the new domain.

| Service | Address to paste | Guide |
|---|---|---|
| Meta: Connect WhatsApp webhook | `https://app.agreemcrm.com/api/v1/webhooks/meta` | `WHATSAPP_SETUP.md` A3 |
| Meta: App domains / JavaScript SDK domains | `app.agreemcrm.com` / `https://app.agreemcrm.com/` | `WHATSAPP_SETUP.md` A3 |
| Meta: Privacy, Terms, data deletion | `https://app.agreemcrm.com/crm/frontend/privacy.html`, `…/terms.html`, `…/privacy.html#data-deletion` | `WHATSAPP_SETUP.md` A3 |
| Meta: domain verification | Business settings → Brand safety → **Domains** → `agreemcrm.com` → add the **TXT** record Meta shows in Cloudflare | `WHATSAPP_SETUP.md` A2 |
| Razorpay plan billing webhook | `https://app.agreemcrm.com/api/v1/webhooks/billing/razorpay` | `BILLING_SETUP.md` §3 |
| Lead sources (IndiaMART push, Facebook, Google Ads, JustDial, TradeIndia) | Settings → Lead sources shows each | `RENDER_SETUP.md` step 5 |
| Each company's Razorpay or Cashfree | Settings → Payments shows it | `PAYMENTS_SETUP.md` |
| Web push | Render → Environment: `VAPID_SUBJECT=https://app.agreemcrm.com` | `RENDER_SETUP.md` step 7 |

## Step 7: email on the domain

**Emails the CRM sends (invites, trials, invoices):** follow `docs/EMAIL_SETUP.md` with
`mail.agreemcrm.com`. Add Resend's TXT and MX records in Cloudflare. If there is a CNAME, set it to
**DNS only**. Then add the DMARC record (`_dmarc.mail.agreemcrm.com`). On Render:

```
EMAIL_FROM=AgreemCRM <hello@mail.agreemcrm.com>
```

`RESEND_API_KEY` goes only into Render's Environment, never into a chat.

**An inbox for people (support@, billing@, sales@):** Zoho Mail (it has a free plan for a few
users) or Google Workspace. Follow their "add domain" steps and add their MX, SPF and DKIM records
in Cloudflare on `agreemcrm.com`. This does not clash with Resend, because Resend uses
`mail.agreemcrm.com`. `BILLING_SELLER_EMAIL=billing@agreemcrm.com` needs this inbox to receive
mail.

## Step 8 (optional): staging on `staging.agreemcrm.com`

The same as step 3, for the **yellow-crm-staging** service: custom domain
`staging.agreemcrm.com`, CNAME `staging` → the staging onrender.com address (**DNS only**), and
the staging service's `PUBLIC_URL=https://staging.agreemcrm.com`. Add it to Google's origins too.

---

## If something goes wrong

| Symptom | Fix |
|---|---|
| Cloudflare still says "Pending" after a day | The nameservers at the seller are not exactly Cloudflare's two, or DNSSEC is still on at the seller. |
| Render keeps "Verifying" / no certificate | The `app` CNAME is **Proxied (orange)**. Set it to **DNS only (grey)**, then press Verify again. |
| "Too many redirects" | A Redirect Rule catches `app.agreemcrm.com`. Use the hostname filter from step 5. |
| Google says `origin_mismatch` | Step 4: the origin is missing or has a `/` at the end. |
| WhatsApp messages stop arriving | Meta's callback still points at the old onrender.com address (step 6). |
| Resend says the domain is not verified | A record was added to `agreemcrm.com` instead of under `mail`, or a CNAME is Proxied. |
