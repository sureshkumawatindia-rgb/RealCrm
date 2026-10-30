# The last 5%: plan (2026-10-27)

The user's prompt is `docs/LAST_5_PERCENT_PROMPT.md` (2026-10-10). Since it was written, the ten
master-prompt phases (D73–D92) and the foundation weeks (D93–D96) built part of it, so this plan
first lists what exists (checked in the code on 2026-10-27), then only what is left. Work is on
the branch `feature/last-5-percent`, cut from `feature/hindi-pages` (598a0ed). Nothing is merged
or pushed without the user's word. New decisions in `docs/BIZNUMA_ROADMAP.md` start at D99.

## The user's answers (2026-10-27)

| Question | Answer |
| --- | --- |
| Start now or after polish plan CP2? | Start now on a new branch. CP2 (business profile, health alerts, App Review kit, data-deletion page) waits for the user's legal details. |
| Email service | **Resend**: free 3,000 emails a month, 100 a day, 3 domains; Pro $20 a month for 50,000 (resend.com/pricing, checked 2026-10-27). Called over HTTPS with `fetch`, so no new npm package. |
| When a tax invoice is made | A **"Create tax invoice"** button on the order, plus a company setting "make it when the order is Dispatched", **off** by default. |
| Tax invoice number | **`INV/26-27/0001`**: the prefix (default `INV`, up to 4 letters) can be changed in Settings; the year part is the financial year (1 April to 31 March); the counter starts again each year. It stays within 16 characters up to 99,999 invoices a year (CGST Rule 46(b): at most 16 characters, letters, digits, `-` and `/`, unique in a financial year). Credit notes: `CN/26-27/0001`. |
| Platform admin panel | Only the emails in `PLATFORM_ADMIN_EMAILS`, with 2-step login on; every action audited; **no** login inside a company (no impersonation); counts and status only, never a company's chats or customers. |
| Optional features | All eight: leads import, lead scoring, ticket SLA, Google Sheets sync, Tally export, WhatsApp Flows, WhatsApp calling, Instagram + Messenger inbox. |
| Automations on bulk stage changes | A **"Run automations too"** tick box in the bulk window, **off** by default. The same applies to the existing bulk actions on Boards (today they run automations). |

## Already built (not rebuilt)

| Prompt item | Where it is now |
| --- | --- |
| 1. Custom fields | D73–D74: customers, leads and deals; forms, lists, filters, import, export, public API, webhooks, search. Gaps in checkpoint A below. |
| 2. Own lead stages | D84: up to 10 pipelines with 2–12 stages each, every stage of a fixed kind, Won/Lost (with reason) in every pipeline, migration 007, stage history. |
| 3. Bulk actions | Partly, D89: `POST /bulk/leads` (assign, stage, follow-up, tag, sequence, SMS; 200 at a time) from Boards. Lists and customers in checkpoint B. |
| 4. Excel import | D82: `.xlsx` in and out without a library (`utils/xlsx.js`), same mapping and dry run as CSV. Question 2 of the prompt (exceljs) is no longer needed. |
| Optional: R2 storage, error monitoring | D94 (Cloudflare R2), D93 (Sentry and alerts). |

## Checkpoints

One at a time. After each: all tests, a commit, a Hinglish report with before → after, and
the user's "go" for the next. Every feature follows the prompt's common rules: the company from
`req.tenant`, permissions on the server, audit log, private numbers (D61) and number masking
(D65) everywhere, no business data in `localStorage`, Hindi and dark mode on new screens, rules
of Meta, GST and Resend checked in their current official docs (with "checked on <date>").

**A. Custom field gaps** (small) — done 2026-10-27 (D99)
- Custom fields as conditions in automations and the workflow builder.
- Custom fields as variables in messages (quick replies, sequences, template variables).
- The Inbox contact panel shows them (with field access, D77).
- The public API writes leads' custom fields (D74 left them read-only).

**B. Bulk actions and duplicates** — done 2026-10-28 (D100)
- Leads and Customers lists: tick boxes, "Select all N matching" (the whole filter, not only the
  page). Actions: owner, stage (leads), add/remove tag, segment (customers), sequence, export,
  delete (with a confirm).
- Server: `/bulk/leads` grows, `/bulk/contacts` is new. Up to 200 at once directly, up to 5,000
  through the job queue with progress; `Idempotency-Key`; an audit entry per record; a report at
  the end ("480 done, 20 skipped: private"). The "Run automations too" box (answer above).
- "Possible duplicates" (same phone, email or GSTIN) and a merge: pick the main record and each
  field's value; leads, chats and messages, quotations, orders, payments, notes, tasks, tickets,
  documents, segments and sequence enrollments move to it; two chats on one WhatsApp number are
  joined into one. In a transaction, audited, with a clear "cannot be undone" warning.

**C. GST tax invoice** — done 2026-10-28 (D101)
- A "Tax Invoice" made from an order (or an accepted quotation) by the button, or on Dispatched
  when the setting is on. Gap-free numbers per financial year (`Counter`), money from
  `utils/gst.js` (CGST/SGST/IGST, round-off, place of supply), lines from `documentParts`.
- PDF "TAX INVOICE": HSN/SAC, GST summary, amount in words, bank details, UPI QR (the
  `quotationPdf.js` pattern). Send on WhatsApp (a document inside 24 hours, a document template
  outside).
- Payment receipts; the order's amount paid on the invoice. An issued invoice is never edited; a
  **credit note** cancels it or part of it. Reports: invoiced vs collected.
- No e-invoice (IRN) or e-way bill. The docs say when e-invoicing becomes compulsory (the
  turnover limit checked on the GST portal at the time) and how it would be added later.

**D. Where leads come from: ads and the website button** — done 2026-10-29 (D102)
- Click-to-WhatsApp ads: the inbound message's `referral` (fields checked in Meta's docs) sets
  the lead's source "WhatsApp Ad" and its ad details (the D79 touchpoints); reports by source and
  by ad; `ctwa_clid` in the Conversions API events (D53) if Meta's docs allow; "Came from ad:
  <headline>" in the Inbox.
- A website WhatsApp button: one small script like `embed.js`, a floating button with greeting,
  optional agent name and photo, "Usually replies in…" from working hours; it opens `wa.me` with a
  ready message carrying a short ref code (source "Website widget" and the page). Settings: colour,
  position, text, a live preview and the snippet. A public key per company, no tracking cookie,
  no effect on the site's own CSS.

**E. Inbox: the last features** — done 2026-10-30 (D103)
- Quick replies with a photo, PDF or video (from documents storage), sent with the text.
- Send later: schedule a message, edit or cancel it; at send time the 24-hour window is checked
  again, and if it is closed the message is not sent and the agent gets a bell alert with a
  template option.
- Customer feedback (CSAT): when a chat is resolved and the company setting is on, one question
  with buttons (Good / Okay / Bad), only inside the 24-hour window, at most once a day per
  customer, never to private numbers; scores in Team live, My performance and Reports.
- Block a contact: no automation, bot, auto-reply, lead or broadcast for them; a "Blocked" filter;
  unblock; audited. Blocked on Meta too if the Cloud API's block endpoint allows it (checked in
  Meta's docs, including on coexistence numbers). Read 2026-10-29: `block_users` takes only
  someone who wrote in the last 24 hours, and the docs say nothing about coexistence numbers, so
  the CRM tries and keeps Meta's answer ("Blocked here only" with WhatsApp's reason).

**F. Running the SaaS**
- Platform admin panel (access as answered above): all companies with plan, trial end, users,
  WhatsApp numbers, contacts, broadcasts this month, last active and WhatsApp health; MRR, new
  sign-ups, trial-to-paid and churn from `BillingInvoice` and subscriptions; the `scripts/plan.js`
  actions (comp, extend trial, set plan) as buttons.
- Emails through Resend from the job queue with retries: team invite, trial 7/3/1 days before and
  at the end, payment failed, the plan's invoice (PDF attached), company deletion warning, new
  login alert (optional). Branded, with a plain-text part, in the person's language. No key → the
  CRM keeps working and logs it. `docs/EMAIL_SETUP.md`: account, domain, SPF/DKIM/DMARC, click by
  click.
- `docs/GO_LIVE_CHECKLIST.md`: every task left for the user in one place (Google sign-in, Meta
  verification and App Review, Razorpay/Cashfree live keys and webhooks, Razorpay Subscriptions,
  MSG91 DLT, email domain, Render variables, Atlas paid tier, own domain and HTTPS, backups,
  legal details, Anthropic key and budget), each with its guide and what fails without it. The
  same list in the platform admin's Settings with which keys are set — never their values.

**G. Optional features** (after F, one at a time, smallest first)
1. Leads import (CSV and Excel, with stage, owner and value).
2. Lead scoring: Hot / Warm / Cold from source, reply speed, quotation viewed and orders.
3. Ticket SLA: reply and resolve limits by priority, alerts on breach, a report.
4. Google Sheets sync: new leads or orders added to a sheet (on the existing Google connection).
5. Tally export: invoices and receipts as Tally import XML (needs C).
6. WhatsApp Flows: forms inside WhatsApp, answers into a lead or order.
7. WhatsApp Business calling: only if Meta offers it for Indian numbers (checked first; if not,
   reported and stopped).
8. Instagram and Messenger in the same team inbox (Meta App Review needed).

## What the user will do (asked for at that checkpoint, never before)

- **F:** a Resend account and the domain's DNS records (SPF, DKIM, DMARC); three `.env` keys
  (`RESEND_API_KEY`, `EMAIL_FROM`, `PLATFORM_ADMIN_EMAILS`), with numbered steps. Secrets are
  never pasted in chat.
- **G6–G8:** Meta settings and App Review for Flows, calling and Instagram/Messenger.
- **Polish plan CP2:** the company's legal name, address, email and GSTIN.

The last report ends with: "Code ka kaam poora. Ab sirf GO_LIVE_CHECKLIST ke user wale kaam
baaki hain."
