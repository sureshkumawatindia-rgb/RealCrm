# Emails from the platform (Resend, D104)

The CRM sends eight kinds of email, each in the person's language (English or Hindi, from
Settings → Your profile), with a plain-text part and no tracking:

| Email | Who gets it | When |
| --- | --- | --- |
| Team invite | the invited address (in the inviter's language) | an owner or admin invites someone or sends the invite again; the link is still shown to copy or send on WhatsApp |
| Trial ends soon / trial ended | owners and admins | 7, 3 and 1 days before the trial ends, and when it ends (once each) |
| Payment failed / plan stopped | owners and admins | Razorpay could not charge the plan (it tries again), or the payments failed and the plan stopped |
| Plan invoice (PDF attached) | owners and admins | each monthly payment, with the GST tax invoice |
| Company set to be deleted / deleted tomorrow | owners and admins | an owner asks to delete the company, and again on its last day |
| New login | the person | their account is opened on a browser it was never opened on (each person can switch these off under Settings → Your profile → Where you're logged in) |

Until it is set up nothing is emailed, and everything else works as before: the notes under the
bell, web push, the invite links. The platform admin page (Platform admin → Emails) lists every
email with its state: sent, failed (with Resend's reason), waiting, or not sent (no key at the time).

## 1. A Resend account

1. Sign up at [resend.com](https://resend.com). Check the free plan's daily and monthly limits on
   their pricing page; a small CRM sends a few emails a day.

## 2. Your sending domain

Use a subdomain of your website's domain, e.g. `mail.yourdomain.in` (Resend recommends a
subdomain, so these emails never affect your main domain's mail).

1. Resend → **Domains** → **Add Domain** → enter `mail.yourdomain.in`.
2. **Region**: the one closest to most of your users (India: the nearest region Resend lists).
3. Open the **Records** tab. Add every record at your DNS host (GoDaddy, Hostinger, Cloudflare …)
   **exactly** as Resend shows it — names and values: the **TXT** records (SPF and DKIM) and the
   **MX** record (for bounces). On Cloudflare, switch the proxy (orange cloud) **off** for any CNAME.
4. Wait until the domain shows **Verified**: often within 15 minutes; DNS can take up to 72 hours.
   If it is still pending after that, press **Restart verification**.
5. After it is verified, add **DMARC** at your DNS host — a TXT record:
   - Name: `_dmarc.mail.yourdomain.in` (or `_dmarc.yourdomain.in` for the whole domain)
   - Value: `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.in;`

   Start with `p=none`. When the reports show all your mail passing, change it to `p=quarantine`,
   and later to `p=reject`.

## 3. An API key

Resend → **API Keys** → **Create API Key**:

- **Permission**: Sending access (it can only send emails).
- **Domain**: `mail.yourdomain.in`.
- Copy the key now — Resend never shows it again. Never paste it in a chat or a document.

## 4. Tell the CRM

Add two lines to `backend/.env` (and, on Render, under the service's **Environment**):

```
RESEND_API_KEY=<the key>
EMAIL_FROM=AgreemCRM <hello@mail.yourdomain.in>
```

`EMAIL_FROM` must be an address on the verified domain; the name before `<` is what people see.
Both keys go together: with only one, nothing is sent (the server log says so at start).
Restart the backend (stop-crm, then start-crm; on Render it restarts by itself after saving).

## 5. Check it

1. Settings → Team & Access → invite a second email address of your own. The toast says
   "Invite emailed to …" and the email arrives within a minute.
2. Platform admin → **Emails**: the invite is **Sent**. A **Failed** one shows Resend's reason:
   - `403 validation_error … domain is not verified` — finish section 2;
   - `422 …` — `EMAIL_FROM` is not an address on the verified domain;
   - `401 …` — the key is wrong or was deleted: make a new one (section 3).
3. Settings → Your profile → **Where you're logged in** now shows "Email me about new logins".

## How the CRM calls Resend (read 2026-10-30)

`POST https://api.resend.com/emails` with `Authorization: Bearer <key>` and a JSON body
`{ from, to, subject, html, text, attachments: [{ filename, content (Base64) }], tags }`; the
answer is `{ id }`. Every email is a job of its own (`email.send`) with an `Idempotency-Key`
header (`crm-email-<id>`; Resend keeps it 24 hours), so a try again never sends it twice. Tried
again, with growing waits, up to 6 times on `429 rate_limit_exceeded`, `409` (a request with the
same key still running), `500`, `502`, `503`, `504` and when Resend does not answer in 15
seconds; never on other `4xx` errors or the daily and monthly quota errors. The invite link is
stored encrypted until the email is sent, then removed; emails are kept 180 days
(`emaildeliveries`).
