# Launch rehearsal: one full go-live run on staging, then the launch

Phase 10 of the 100 phases (D153), 2026-11-14. Before the first paying customer, the owner runs
the whole CRM once on **staging** with real test accounts, the way a customer will, then does the
same short check on production on launch day. Part 1 is automatic (a command); part 2 is a list
of things to do by hand, with what you should see.

Before you start: staging exists (docs/FOUNDATION_SETUP_STEPS.md sections A–C) and production's
settings are in place (docs/GO_LIVE_CHECKLIST.md steps 1–6). Nothing here needs a key in chat.

## Part 1 — The automatic check (5 minutes)

On your computer, in VS Code's terminal, in the `backend` folder:

```
npm run rehearsal -- https://<your-staging>.onrender.com
```

and on launch day:

```
npm run rehearsal -- https://crm.agreem360.com --site https://agreem360.com
```

It looks at the CRM from outside, as a visitor, Meta and Razorpay will. It needs no key and
changes nothing. Each line is **PASS**, **WARN** (works, still something to do) or **FAIL** (fix
before launch):

| Check | What it looks at | A FAIL or WARN usually means |
|---|---|---|
| Server and database | `/api/v1/health`: UP, which copy (staging/production), the version | The service is not running, or Atlas refuses its address (Network Access) |
| HTTPS, http:// goes to https:// | The address and plain http | The custom domain's certificate is not ready yet (Render → Custom Domains) |
| The root address, the pages | `/`, the home page, sign-in, the 5 policy pages, status, the agreem360 website, an unknown page (404) | A deploy from an old commit |
| The status page address | `/status` | As above |
| Security headers | CSP, X-Frame-Options, nosniff, and HSTS on production | As above |
| PUBLIC_URL | The address search engines, emails, webhooks and Google are given | `PUBLIC_URL` on Render is not this address — fix it **before** connecting Google and Meta |
| Status | Every part of the status page is working | Meta or a gateway in trouble right now (see the status page) |
| Your legal details | `BILLING_SELLER_NAME`, `_ADDRESS`, `_GSTIN`, `_EMAIL` | Not set on Render (GO_LIVE_CHECKLIST step 9) |
| Support details | WhatsApp, email, hours | Not set on the platform admin page → Support |
| Plans | The 5 plans and the 45-day trial | A wrong deploy |
| Phone app | `sw.js` with its file list | A wrong deploy |
| Meta webhook | Refuses messages Meta did not sign | `META_APP_SECRET` not set yet (WARN) |
| Developer tools off | Production only | `DEV_TOOLS` is on in production — switch it off at once |
| agreem360 website | With `--site`: agreem360.com answers with the website | GoDaddy forwarding (docs/DOMAIN_SETUP.md G2b) |

The rehearsal is ready when there is no FAIL. WARN lines are fine on staging (no legal details,
no Meta secret); on launch day only "Support details" may still be WARN for a few minutes.

## Part 2 — By hand, with real test accounts (about 2 hours)

Do it on **staging** first, in a normal browser window and on your phone. Write down anything
that looks wrong (a screenshot is best). Use test data only: staging must never hold real
customers' data.

### A. A new business signs up (15 min)
1. Open the home page, choose **For your business ▾ → Pest Control**, then **Start free trial**.
2. Sign in with a Google account that has never used the CRM.
   - You see: connect WhatsApp (skip it for now) → invite your team (skip) → the company form with
     **CRM Type = Pest Control** already chosen. Fill the name, GSTIN and address, **Save**.
   - The menu now says Enquiries, Jobs, Treatments; the dashboard shows "Get your CRM ready".
3. Settings → Plan: Growth, **free trial, 45 days left**.
4. Switch to **हिंदी** at the top: every page you open speaks Hindi; switch back.

### B. WhatsApp (30 min, needs the staging WhatsApp test number)
1. Connect WhatsApp (docs/WHATSAPP_SETUP.md, the staging app's test number).
2. From your own phone, send "Rate list bhejiye" to the test number.
   - You see: the chat in the Inbox within seconds, a new lead and customer.
3. Reply from the Inbox, send a quick reply with a file, a voice note.
   - You see: the ticks turn blue on your phone.
4. Turn the phone's internet off, reply from the CRM on the phone: the reply waits; turn it on: it
   goes once.

### C. Sales (30 min)
1. Make a quotation for the lead, send it on WhatsApp; open the link on your phone.
2. Make the order, then the tax invoice: INV/26-27/0001 with your GSTIN and the customer's state.
3. Make a Razorpay **test mode** payment link (Settings → Payments with Razorpay test keys), pay it
   with Razorpay's test card on your phone.
   - You see: the order paid, the receipt, a bell note.

### D. The team (15 min)
1. Invite a second Google account as an **agent**. Sign in as the agent in another browser.
   - You see: the customer's number masked, only what an agent may open.
2. Assign the chat to the agent; reply as the agent; the owner sees it live.

### E. Money for the plan (15 min, Razorpay test mode)
1. Settings → Plan → choose **Starter monthly**, pay with the test card.
   - You see: the plan active, the plan invoice by email (if Resend is set) and under Billing.

### F. Safety (15 min)
1. Owner: switch on the 2-step login (authenticator app), sign out and in again with the code.
2. Platform admin page (your PLATFORM_ADMIN_EMAILS account): Health — everything working; post a
   test notice "Staging test" for everyone, see the banner inside the CRM and on `/status`, end it.
3. Backups tab: **Run the drill now**: it passes.
4. Settings → Failed sends: empty (or each line with its reason).

### G. Launch day (on production, 30 min)
1. `npm run rehearsal -- https://crm.agreem360.com --site https://agreem360.com`: no FAIL.
2. Sign up your own real business (A), connect the real WhatsApp number (B 1–3).
3. Platform admin → Support: the support WhatsApp, email and hours. Platform admin → Go-live
   checklist: every line green except the optional ones.
4. Post the launch on WhatsApp; keep the status page link for customers who ask "is it down?".

When A–G are done with nothing wrong left, phase 10 is complete: the CRM is live. Phases 11–100
follow what the first customers ask for (docs/HUNDRED_PHASES_PLAN.md).
