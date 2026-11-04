# 100 phases: the best CRM for Indian traders and manufacturers

Started 2026-11-03, after the Last 5% plan (D99–D112) was finished and pushed to GitHub `main`
(`0d79304`). The CRM already does a great deal (decisions D1–D112 in `BIZNUMA_ROADMAP.md`), so
these phases build on it and never repeat it. The goal: the best CRM in the world for one kind of
business — **Indian traders and manufacturers** who sell on WhatsApp, get leads from IndiaMART,
JustDial and their website, and run on GST quotations, orders and Tally.

## The owner's answers (2026-11-03)

| Question | Answer |
| --- | --- |
| When to go live | After phases 1–10 (launch readiness); phases 11–100 then follow real customers' feedback. |
| Who first | Indian traders and manufacturers (WhatsApp-first, Hindi, IndiaMART, GST, Tally). |
| Languages | Hindi complete on every page first; other Indian languages later (phases 91–92). |
| Mobile | The phone app (PWA) at its best first, then an Android app on the Play Store (phase 72). |

## How every phase runs

- One phase per "go" from the owner. Each phase builds, tests (unit and browser), checks the
  pages in Hindi, dark mode and at 375 px, updates the docs, commits, and ends with a Hinglish
  report (done / left, "DONE BIG BRO").
- The owner's own files and uncommitted work are never touched; nothing is pushed unless the
  owner says so; secrets never go into a chat (numbered `.env` steps instead).
- Every tenth phase from 20 on is a **feedback round**: the issues real customers hit most
  (support chats, error reports, usage), fixed before new work.
- After phase 10 the order of phases 11–100 may change with what paying customers ask for: this
  plan is a menu in a sensible order, not a contract.
- Phases marked *(needs your account)* use a service the owner signs up for; the code works
  without it and says what is missing.

## Part 1 — Ready to launch (1–10)

1. **Security review.** One company never sees another's data (every route checked); sign-in and
   sessions; file uploads; webhook signatures; rate limits; no secrets or customers' numbers in
   logs. Fix every finding; a test for each. — done 2026-11-03 (D113, `docs/SECURITY_REVIEW.md`)
2. **End-to-end browser tests.** The ten flows that must never break (sign up → test WhatsApp
   number → a lead arrives → reply → quotation → order → invoice → payment → report → team
   invite), run in GitHub on every push. — done 2026-11-03 (D114, `docs/E2E_TESTS.md`)
3. **Speed at scale.** A company with 20,000 contacts, 50,000 leads and 2 lakh messages: the
   Inbox, lists, search and reports answer within a second (indexes, paging, lighter queries).
   — done 2026-11-03 (D115, `docs/SPEED_AT_SCALE.md`)
4. **Hindi everywhere.** Every remaining page in Hindi, and a test that stops English-only text
   from coming back. — done 2026-11-04 (D116, `docs/HINDI_GUIDE.md`)
5. **The first day.** A "Getting started" checklist (connect WhatsApp, add products, import leads,
   invite the team, send the first quotation) and ready settings for traders and manufacturers
   (stages, quick replies, quotation terms).
6. **Help inside the CRM.** Short Hindi and English help on each page, a help centre, and a
   WhatsApp button to the platform's support number.
7. **Phone app, part 1.** Installable, opens without the network, replies wait and go when the
   network is back, a faster Inbox on 4G.
8. **Data trust.** A customer's data exported or deleted on request (DPDP Act), the company's
   privacy settings, and the backup restore drill shown on the platform admin page.
9. **Reliability.** A public status page, clear banners when Meta or a payment gateway is down,
   failed sends and webhooks visible and retried.
10. **Launch rehearsal.** A full go-live run on staging with the owner's real test accounts, then
    the launch (the owner's `GO_LIVE_CHECKLIST.md` tasks).

## Part 2 — What the first customers need (11–20)

11. **Bring your data.** Import presets for Excel, BizNuma, Zoho and HubSpot exports (contacts,
    leads, products), with a preview.
12. **Products for manufacturers.** Variants (size, grade, packing), price lists per customer
    group, minimum order quantity; quotations pick variants.
13. **Better quotations.** Accept with a one-time code, reminders before validity ends, compare
    revisions, letterhead designs.
14. **"Aaj ke kaam".** Each salesperson's day: calls due, quotations to chase, payments due — on
    the dashboard and as a WhatsApp morning summary.
15. **Payment reminders.** Automatic WhatsApp reminders for dues (polite, then firm) with a
    payment link, stopped by the payment; ageing buckets.
16. **Dispatch.** Transporter and LR number, tracking link, dispatch photo, WhatsApp updates to the
    customer; Shiprocket *(needs your account)*.
17. **Stock.** Stock per product and godown, reserved by orders, low-stock alerts.
18. **Purchases.** Vendors, purchase orders and goods received, feeding the stock.
19. **Field sales.** Visit check-in and check-out with location, notes and photos, beat plans, a
    manager's map.
20. **Feedback round 1.**

## Part 3 — The best Inbox (21–30)

21. **Smart routing.** Chats assigned by language, product, workload and who is online.
22. **Find anything.** Search inside messages; filters (unanswered for N minutes, tag, channel);
    saved views.
23. **Translation.** Chats translated between Hindi, English and other languages for the agent.
24. **AI chat summary.** One tap: what the customer wants, what was promised, the next step.
25. **Voice notes to text.** Hindi voice notes written out in the chat and searchable.
26. **Teamwork in chats.** @mention a teammate inside a chat, a handover note when passing it on.
27. **Template library.** Ready Hindi and English WhatsApp templates for traders, sent to Meta in
    one click.
28. **Campaign replies.** Replies to a broadcast grouped and tagged; opt-outs counted.
29. **Customer link.** A secure link where the customer sees quotations, orders, invoices and
    payments, and reorders.
30. **Feedback round 2.**

## Part 4 — AI that works for the trader (31–40)

31. **AI fills the lead.** Product, quantity, city and budget read from a WhatsApp or IndiaMART
    message into the lead (checked before saving).
32. **AI quotation draft.** "50 kg jeera, Jaipur" in a chat becomes a draft quotation to check.
33. **Ask your CRM.** Questions in Hindi or English ("is mahine sabse zyada enquiry kis product
    ki?") answered from the reports.
34. **Who to call today.** A daily list with the reason for each lead.
35. **Reply tone.** Formal, friendly or Hinglish presets; a library of approved answers.
36. **AI campaign writer.** Festival and offer messages in Hindi and English within Meta's rules.
37. **AI data clean-up.** Suggested merges, tidied names and cities, standard product names.
38. **AI coach.** A weekly note to managers on response times and lost reasons.
39. **AI controls.** Budgets per company, a log of every AI action, which actions need a person.
40. **Feedback round 3.**

## Part 5 — Selling more (41–50)

41. **Targets and incentives.** Monthly targets per person and team, progress, commission.
42. **Forecast.** Expected sales by month against targets.
43. **Why deals are lost.** Reasons, competitors, price gaps; win-back campaigns.
44. **Repeat orders.** Each customer's buying cycle; "due for reorder" list and reminders.
45. **Customer tiers.** Dealer, distributor and retailer; credit limits and payment terms.
46. **Credit control.** Orders over the credit limit or with overdue bills need approval.
47. **Dealer network.** Dealer accounts, their orders, a dealer portal.
48. **Schemes.** Quantity slabs and "buy X get Y", applied in quotations and orders.
49. **New price list.** Update prices and tell chosen customers the new rates.
50. **Feedback round 4.**

## Part 6 — Marketing that brings leads (51–60)

51. **Marketplace leads.** Reply to IndiaMART, JustDial and TradeIndia leads within a minute,
    duplicates across sources, cost and return per source.
52. **Ad returns.** Meta and Google ad spend brought in; cost per lead and per order *(needs your
    account)*.
53. **Landing pages.** Simple Hindi and English pages with a form and the WhatsApp button.
54. **Instagram growth.** Comment-to-DM, story replies, keyword triggers.
55. **Google reviews.** Happy customers (CSAT) asked for a review; tracked.
56. **Customer referrals.** Referral codes and rewards for the business's own customers.
57. **Festival calendar.** Ready campaigns for Indian festivals with suggested segments.
58. **Better broadcasts.** A/B tests and the best time to send.
59. **Journeys.** Step-by-step journeys across WhatsApp, SMS and email.
60. **Feedback round 5.**

## Part 7 — Money and accounts (61–70)

61. **GST e-invoice** (IRN and QR) for companies above the limit *(needs a GSP account)*.
62. **E-way bill** for dispatches *(needs a GSP account)*.
63. **Tally both ways.** Payment status and ledgers brought back from Tally.
64. **Other accounting software.** Zoho Books, Busy and Marg exports.
65. **UPI and bank.** A UPI QR on invoices; bank statement import that matches payments.
66. **Contracts.** Recurring invoices, AMC and service contracts, renewal reminders.
67. **Costs.** Vendor bills and expenses; profit per order.
68. **Branches.** Branches with their own GSTIN, numbering and stock.
69. **Money dashboard.** Cash flow, receivables, top customers by profit.
70. **Feedback round 6.**

## Part 8 — Mobile and the field (71–80)

71. **Phone app, part 2.** An owner's home screen (today's sales, dues, chats) and quick actions.
72. **Android app** on the Play Store: notifications, links into the app, share to the CRM
    *(needs a Play Console account)*.
73. **Call logging on Android.** Calls with customers logged from the phone (with permission).
74. **Card scan.** A visiting card photo becomes a contact.
75. **Offline field work.** Visits, notes and orders taken without the network, synced later.
76. **Barcodes.** Barcode and QR labels for products and stock.
77. **Voice notes for the CRM.** Notes and tasks added by voice in Hindi.
78. **Notifications.** Each person's rules, quiet hours and a daily digest.
79. **Shop counter mode.** Quick order taking on a tablet.
80. **Feedback round 7.**

## Part 9 — Platform and partners (81–90)

81. **Zapier, Make and Pabbly.** Triggers and actions on the public API.
82. **Integrations page.** One place to connect every service.
83. **API v2.** A cleaner public API, an SDK and a documentation site.
84. **Partners.** A reseller dashboard, white label (logo and domain), partner commissions.
85. **Several companies.** One owner's combined view of all their companies.
86. **Sharing rules.** Teams, hierarchy and record sharing on top of field access.
87. **Custom modules.** Forms, list views and automations for custom objects.
88. **Data centre.** Scheduled exports and the company's own backups.
89. **Compliance centre.** Who saw or exported which data.
90. **Feedback round 8.**

## Part 10 — Scale and the world's best (91–100)

91. **Indian languages 1.** Marathi and Gujarati.
92. **Indian languages 2.** Tamil, Telugu and Bengali.
93. **Ten times bigger.** A million messages per company; archiving; a plan for big companies.
94. **Security certification readiness.** ISO 27001-style controls and an outside penetration
    test *(needs a security firm)*.
95. **Growth tools.** Annual plans, coupons, add-ons (extra numbers and agents), upgrade prompts.
96. **Customer success.** A health score for each company, churn alerts, NPS.
97. **Exporters.** Quotations and proformas in other currencies, zero-rated GST under LUT.
98. **Accessibility and polish.** WCAG AA, keyboard and screen readers, one consistent design.
99. **Benchmark.** Every key flow compared with the best CRMs; the gaps that matter closed.
100. **Feedback round 9 and the world-best release.** Final polish, case studies, version 2.

## What the owner does along the way

- **Before and at phase 10:** the `GO_LIVE_CHECKLIST.md` tasks (Render, domain, Atlas, Google,
  Meta verification and App Review, Razorpay, Resend, R2, Sentry), and 5–10 pilot businesses.
- **From phase 11:** a WhatsApp group with the pilot customers, and the accounts marked
  *(needs your account)* when their phase comes.
