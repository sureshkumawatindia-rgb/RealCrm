# Login codes by SMS (the backup)

The login sends its 6-digit code on WhatsApp (docs/WHATSAPP_SETUP.md). When it does not arrive, the code step offers **"Get the code by SMS instead"** — the same code rules (5 minutes, one use, 5 tries, at most 3 codes per number in 15 minutes), sent through **MSG91**. Until it is set up, the link does not show (production default `SMS_PROVIDER=off`). In development (`SMS_PROVIDER=mock`, the default) nothing is sent and the code is shown on the screen.

In India every business SMS must use a **DLT**-registered sender and template (TRAI rule), so this takes a few days the first time.

## 1. DLT (once, for your business)

1. Register your business as a **Principal Entity** on one operator's DLT portal (Jio, Airtel, Vi or BSNL; one is enough). You need the PAN, GST certificate or other proof and a letter of authorisation; there is a one-time fee. Note your **Entity ID**.
2. Register a **Header** (the sender name people see, 6 letters, e.g. `YLWCRM`), category *Transactional / Service*.
3. Register a **content template** of type *Service Implicit* (OTP), for example:
   `{#var#} is your YELLOW CRM login code. It expires in 5 minutes. Do not share it. - YLWCRM`
   Wait for approval and note the **DLT template ID**.

## 2. MSG91

1. Sign up at [msg91.com](https://msg91.com), complete the KYC and add credit.
2. Add your DLT **Entity ID** and the **Header** (sender ID).
3. **OTP** → *Create template*: paste the same text as the DLT template with `##OTP##` where the code goes, choose the sender, enter the **DLT template ID**, and save. Copy MSG91's **template ID** (not the DLT one).
4. **Auth key**: your account → *Authkey* → create one. Keep it private.

## 3. Tell the CRM

Add to `backend/.env` (and, on Render, under the service's *Environment*):

```
SMS_PROVIDER=msg91
MSG91_AUTH_KEY=<the auth key>
MSG91_OTP_TEMPLATE_ID=<MSG91's template ID>
```

Restart the backend (stop-crm, then start-crm; or `rs` in its terminal).

## 4. Check it

Log out, open the login page: Google → your number → *Get a code on WhatsApp* → on the code step, *Get the code by SMS instead*. If no SMS comes, the page shows MSG91's reason outside production, and the backend log always has it ("SMS login code not sent: …"). Common ones: the template is not DLT-approved yet, the sender ID or template ID is wrong, no credit left.

How the CRM calls MSG91 (checked 2026-10-08): `POST https://control.msg91.com/api/v5/otp?template_id=…&mobile=91…&otp=…&otp_expiry=5` with the `authkey` header; an answer with `"type": "error"` is a failure even with HTTP 200.
