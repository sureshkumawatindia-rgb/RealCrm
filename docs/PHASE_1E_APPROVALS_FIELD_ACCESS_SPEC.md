# Phase 1E: Approval rules and field access (spec)

Status: **approved 2026-10-20 with the three defaults, and built 2026-10-21 (not committed)**. What was built and how it differs from this spec is in sections 14 and 15. This is sub-phase 1E ("approval/visibility rules") of "Deep Customization" in `docs/CRM_10_FEATURE_IMPLEMENTATION_PROMPT.md`. It builds on 1A–1D (D73–D76).

## 1. Goal

Two controls an owner of a small Indian business asks for early:

1. **Discount approval.** "My salespeople should not give more than 10% discount without asking me." A quotation that crosses the owner's limits cannot reach the customer until an owner or admin approves it, from the bell, in a couple of taps.
2. **Field access.** "Agents should not see our purchase price or margin" and "only I can change a customer's credit limit." Each custom field can be hidden from agents or viewers, or shown to them read-only.

## 2. What exists today (from the code)

- **Roles and modules.** There are four roles: owner, admin, agent and viewer. Agents and viewers only open the modules they were given. Agents see only their own records unless they have `<module>:view_all` (`constants/permissions.js`, `services/access.js`, D17). There is nothing per field, except phone masking (D65).
- **Custom field values.** The value of every active field is returned through `customFieldService.visibleValues` (contacts, leads, records). Values are also used by:
  - field filters and search (`customFieldFilters.js`);
  - list columns;
  - CSV import mapping (`contactImportService.js`);
  - link names (`lookupService.js`);
  - the full export (owners and admins only);
  - the public API (keys are made by owners and admins only);
  - outbound webhooks.
- **Quotations.** A quotation's status is Draft, Sent, Viewed, Accepted, Rejected or Expired (`constants/crm.js`). A quotation reaches the customer in three ways:
  - `POST /quotations/:id/send`, into the WhatsApp chat;
  - `PATCH /quotations/:id { status: "Sent" }`, when sent by hand;
  - the customer link `/q/<token>` and `GET /quotations/:id/pdf`.

  Each line has a discount (% or amount). The totals have `subtotalPaise`, `discountPaise` and `grandTotalPaise` (`utils/gst.js`). Quotations are built on the Quotations page (`js/quotations.js`), and also sent from a lead and from the inbox.
- **Notifications.** `notificationService.notify(org, memberIds, …)` puts an item in the bell and pushes it live (`bus` → socket).
- **No approvals exist anywhere today.**

## 3. Zoho CRM benchmark (official pages, checked 2026-10-20)

Sources:
- [Edition comparison](https://www.zoho.com/crm/comparison.html)
- [Adding Approval Process](https://help.zoho.com/portal/en/kb/crm/process-management/approval-process/articles/add-approval-process)
- [FAQs on Roles and Profiles](https://help.zoho.com/portal/en/kb/crm/faqs/roles-and-profiles/articles/faqs-roles-and-profiles)

What Zoho does well:
- **Approvals.** The rule criteria pick the records. A rule starts on create, on edit, or both. Approvers can be a user, a role, a group, a level of the hierarchy, the record owner or the owner's manager. A rule can have up to 10 stages, with "anyone" or "everyone" approving. The record shows "Waiting for approval", and Convert and Delete are switched off. Approval or rejection can update fields, send emails, call webhooks or run functions. Rejected records can be resubmitted.
- **Field permissions.** Each profile can see a field as hidden, read-only or editable.

Where Zoho is limited:
- **Approvals are only in the top editions.** The comparison page marks "Approval process" for Enterprise and Ultimate only, not Free, Standard or Professional. It showed USD prices for these editions (Enterprise $40 per user per month billed annually), not rupee prices, so the India price is UNVERIFIED.
- **Field permissions start at Professional,** according to the comparison page. The FAQ page itself does not name editions.
- **Setup is spread out.** Approvals live under Process Management, field permissions under Modules and Fields, and profiles under Security Control.

Where YELLOW CRM 1E will be better (each point can be checked):
- **Every plan,** the trial too, gets both.
- **Built for the discount case.** A limit takes two numbers (discount %, total ₹), not a criteria builder. The salesperson sees "needs approval" while building the quotation, before saving.
- **Approval from the bell, on the phone,** in 2 taps (open, Approve), and the salesperson is told live.
- **A field's access is set in the same form** as the field itself.

Where it will **not** be better yet:
- Only **quotations** have approvals: no stages, no "everyone must approve", no approval for deals, orders or records.
- Access is per **role** (agent, viewer), not per person or custom profile.

## 4. Scope

In 1E:

1. **Approval rules for quotations** (Settings → a new **Approvals** tab, owners and admins):
   - Each rule has a name, "discount more than **X %**" and/or "total more than **₹ Y**", and who it applies to: **agents** (default), and optionally **admins**. Owners are never stopped.
   - Up to 10 active rules. A quotation needs approval when **any** active rule matches. All three types count: Quotation, Estimate and Proforma Invoice.
   - The discount is the whole quotation's: `discountPaise ÷ subtotalPaise`.
2. **The approval flow:**
   - The quotation builder shows "Needs approval: discount 18% is above 10%" as soon as it applies, using the preview.
   - Instead of Send, the salesperson has **Ask for approval**. Every active owner and admin (other than the one asking) gets a bell notification.
   - The approver opens it and taps **Approve**, or **Reject** with a reason. The salesperson gets a bell notification, and the lead timeline records it.
   - Until it is approved, the salesperson **cannot send it on WhatsApp, mark it Sent, open the customer link or download the PDF** (decision 3).
   - Editing the quotation after asking cancels the request; editing it after approval needs a new approval if it still matches a rule.
   - The Quotations page gets a filter, **Waiting for my approval**.
3. **Field access** for every custom field (customers, leads & deals, records):
   - **Agents:** Edit (default) / See only / Hidden.
   - **Viewers:** See (default) / Hidden.
   - Owners and admins always see and edit everything.
   - A hidden field disappears for that role everywhere: forms, Customer 360, lists, columns, filters, search, link names, CSV import and record tabs.
   - A "see only" field is shown but cannot be changed.
4. **English and Hindi** for every new screen text, and phones at 390 px.

Not in 1E: multi-stage approvals; approvals on deals, orders, payment links or records; per-person or custom profiles; access rules for built-in fields (phone masking stays as D65); the integration/webhook registry (1F).

## 5. Data model

**`ApprovalRule`** (new):

| Field | Rule |
|---|---|
| `organizationId` | required |
| `object` | `quotation` (the only one in 1E) |
| `name` | 1–60 characters |
| `discountPercentAbove` | optional, 0–100, up to 2 decimals |
| `grandTotalAbovePaise` | optional, a whole number ≥ 0; at least one of the two conditions is required |
| `appliesTo` | `["agent"]` or `["agent", "admin"]` |
| `status` | `active` / `archived`; at most 10 active |
| `version`, `createdById`, `updatedById`, timestamps | |

**`Quotation.approval`** (new, optional):

| Field | Meaning |
|---|---|
| `state` | `pending`, `approved` or `rejected` |
| `reasons` | the matched limits, for example "Discount 18% is above 10% (Dealer discount)" |
| `fingerprint` | a hash of the lines and totals when asked; an approval counts only while the quotation still has it |
| `requestedById`, `requestedAt` | who asked, and when |
| `decidedById`, `decidedAt`, `comment` | who decided, when, and the rejection reason |

Whether a quotation **needs** approval is worked out on every read and save from the active rules, the member and the totals; it is never stored. So archiving a rule frees its quotations at once.

**`CustomFieldDefinition.access`** (new): `{ agent: "edit" | "view" | "hidden", viewer: "view" | "hidden" }`. Missing means `{ agent: "edit", viewer: "view" }`, which is today's behaviour, so no migration is needed.

## 6. API

| Method and path | Who | What |
|---|---|---|
| `GET /approval-rules` | members who can view Leads or Deals | the active rules (agents see their limits); `?status=all` for owners and admins |
| `POST /approval-rules`, `PATCH /approval-rules/:id` | owner, admin | create or change a rule; an 11th active rule gets 422 `RULE_LIMIT`; a stale `version` gets 409 |
| `POST /approval-rules/:id/archive`, `/restore` | owner, admin | archive keeps the rule's history |
| `POST /pricing/preview` (the editor's live totals, exists) | as today | its answer also has `approval: { needed, reasons }` |
| `GET /quotations/:id`, the list | as today | each quotation also has `approval: { needed, state, reasons, requestedBy, decidedBy, decidedAt, comment, canDecide }` |
| `POST /quotations/:id/approval` | the quotation's editors | asks for approval; 409 `NOT_NEEDED` when no rule matches; asking twice is harmless |
| `POST /quotations/:id/approval/decision` | owner, admin (not the asker) | `{ decision: "approve" \| "reject", comment }`; a reject needs a comment; 409 `ALREADY_DECIDED` if someone was first |
| `POST /quotations/:id/send`, `PATCH … status: Sent`, `GET /quotations/:id/pdf`, the customer link | as today | while approval is needed and not given (for the current fingerprint): 409 `APPROVAL_REQUIRED` for members the rule applies to |
| `GET /quotations?approval=pending` | owner, admin | the quotations waiting for a decision |
| `POST`/`PATCH /custom-fields` | owner, admin | also accept `access: { agent, viewer }` |
| `GET /custom-fields` | as today | for agents and viewers, hidden fields are left out, and each field has `canEdit` |
| contacts, leads, records (read) | as today | values and links of fields hidden from the member's role are left out |
| contacts, leads, records (write) | as today | a value for a "see only" field gets 400 `FIELD_READ_ONLY`; for a hidden one 400 `UNKNOWN_FIELD`, exactly as if it did not exist |

Every query is scoped to the company. Approvals and decisions are audited (`quotation.approval_requested`, `quotation.approved`, `quotation.approval_rejected`, `approval_rule.*`), and so are access changes (`custom_field.updated`). The full export adds `approvalRules`.

## 7. Screens

- **Settings → Approvals** (a new tab, owners and admins). Each rule is a row: its name, its limits as text ("Discount above 10% · Total above ₹5,00,000"), Edit and Archive. "Add rule" opens a small form: Name, Discount above %, Total above ₹, "Also for admins". It works at 390 px.
- **Quotation builder** (the Quotations page, and when opened from a lead or the inbox):
  - a yellow notice "Needs approval: …" while it applies;
  - **Ask for approval** in place of Send, Mark sent and the PDF for those it applies to;
  - a status chip: "Waiting for approval", "Approved by Asha", or "Rejected: reason".
- **Approver:** the bell item "Ravi asks to approve Q-0042 (₹1,18,000, 18% discount)" opens the quotation, with **Approve** and **Reject** (a reason box) at the top. The Quotations page has the chip **Waiting for my approval (n)**.
- **Settings → Custom fields → field form:** "Agents can: Edit / See only / Hidden" and "Viewers can: See / Hidden", one click each. The field row shows a badge such as "Hidden from agents".

## 8. Edge cases

- **A rule added later** never touches quotations already sent.
- **An admin a rule applies to** cannot approve their own quotation; owners and other admins can. Owners are never stopped. If the only approver is the one asking, the owner is told by the notification and decides.
- **Two approvers at once:** the first decision wins, and the second gets 409 `ALREADY_DECIDED`.
- **Editing:**
  - Changing a pending quotation cancels the request.
  - Changing an approved one so it still matches a rule needs a new approval.
  - Changing it so no rule matches needs nothing.
  - Revise (Sent → Draft) starts fresh.
- **Archived rule or field:** a pending request whose rule was archived no longer blocks anything; the approver sees "No longer needed".
- **A required field an agent may not edit** is not required for agents, so they can still add customers. Owners and admins still must fill it.
- **A hidden field:**
  - inside a section: the section shows the remaining fields, and a section left empty is not shown (D76);
  - as a link field: its link names are not sent either;
  - as a filter saved in a browser: it is dropped quietly, as for archived fields.
- **Public API and webhooks:** API keys are made by owners and admins, so the API sees what they see. Webhooks go to the company's own systems and carry every field, as today.
- **Another company** can never read or use these rules, approvals or access settings.

## 9. Files

New:
- **Backend:**
  - `models/ApprovalRule.js`
  - `services/approvalService.js`
  - `routes/approvalRules.js`
  - `validators/approvals.js`
  - `tests/approvals.test.js`
  - `tests/fieldAccess.test.js`
- **Frontend:** `js/settings-approvals.js`

Changed:
- **Backend:**
  - models: `Quotation.js` (`approval`), `CustomFieldDefinition.js` (`access`)
  - quotations: `services/quotationService.js`, `routes/quotations.js`, `routes/quotationLinks.js`
  - custom fields: `services/customFieldService.js` (the keys a member may see and edit), `customFieldFilters.js`, `lookupService.js`, `contactImportService.js`
  - records that carry custom values: `contactService.js`, `leadService.js`, `customRecordService.js`
  - `exportService.js`, `routes/index.js`, `validators/customFields.js`, `validators/quotations.js`
- **Frontend:**
  - `Settings.html` (Approvals tab, access choices)
  - `js/settings-fields.js`
  - `js/quotations.js` (notice, Ask for approval, Approve/Reject, filter)
  - `js/custom-fields.js` ("see only" inputs)
  - `css/style.css`
  - `i18n/en.json`, `i18n/hi.json` (new keys only; your uncommitted keys are left alone)
- **Docs:** `docs/BIZNUMA_ROADMAP.md` (D77)

No new npm packages, no `.env` changes, no data migration.

## 10. Acceptance checklist

- [ ] Owners and admins add, edit, archive and restore rules; agents and viewers get 403; the 11th active rule gets `RULE_LIMIT`.
- [ ] An agent's quotation over a limit cannot be sent on WhatsApp, marked Sent, opened by link or downloaded as a PDF until it is approved; an owner's never needs approval.
- [ ] Ask → bell for every other owner and admin → Approve or Reject → bell for the asker; the first decision wins.
- [ ] Editing after asking or after approval behaves as in section 8.
- [ ] A field hidden from agents never reaches an agent through any read path: get, list, search, filters, columns, link names, import, Customer 360 and record tabs. A "see only" field cannot be changed by them.
- [ ] Another company cannot read or change any of it.
- [ ] The full test suite has no new failures; every new text is in English and Hindi; checked in the browser on desktop and at 390 px.

## 11. Scorecard targets (goals, not results)

1. **Setup speed:** make a "discount above 10%" rule in **6 clicks or fewer** from Settings.
2. **Approval speed:** from the bell to approved in **2 clicks** (open, Approve), and the salesperson sees "Approved" **within 5 seconds** without reloading.
3. **No leaks:** tests check every read path for a field hidden from agents, with **0** values or link names leaking.
4. **No regressions:** no new failures compared to the 1D commit, which passed 817 of 817 on its own.
5. **Mobile:** the rule form, the approval buttons and the field access choices at 390 px, with no sideways scroll.

## 12. Decisions for you (defaults in bold)

1. **Both parts (approvals and field access) in one go**, as with 1C, or field access first and approvals as a second step.
2. Who rules stop by default: **agents only, with "also for admins" as a choice on each rule**, or agents and admins always.
3. While approval is pending, the salesperson **cannot send it, mark it sent, open the customer link or download the PDF**, or only sending inside the CRM is blocked and the PDF stays available.

## 13. Test baseline

The 1D commit `de7c34c`, run alone, gave **78 suites and 817 tests, all passed**. In the working folder, your uncommitted Hindi work brings back the known Sales Automation key failure, which does not come from this phase.

## 14. What was built, and how it differs from this spec

Built as specified, with these differences:

1. **The customer link needed no change.** It already never shows a draft (the customer sees "being updated"), and a quotation waiting for approval is always a draft. Sending, marking sent or accepted, and the PDF are refused with 409 `APPROVAL_REQUIRED`.
2. **Agents are always in a rule.** `appliesTo` is `["agent"]` or `["agent", "admin"]`; the API adds agents if they are left out.
3. **Which edits need a new approval.**
   - Any edit cancels a pending request.
   - After a decision, only a change to the lines or totals clears it; changing the terms or the note keeps an approval.
4. **The salesperson's page checks for the answer every 4 seconds while it waits.** The Quotations page has no live connection; the bell refreshes every minute and when the tab comes back.
5. **On phones,** an approver gets Approve and Reject in the bottom bar. A reject without a reason is stopped and the reason box is focused.
6. **Bell notes are in English,** like the CRM's other bell notes. Everything on the pages is in English and Hindi.
7. **"See only" in the forms:** the field is greyed out with a lock and "Only an owner or admin can change this", and it is not sent. The API also accepts the same value sent back unchanged, so older pages keep working.
8. **One more read path found while building.** "Quote sent, no reply" (`GET /quotations/awaiting-reply`) returned every stored value of a lead; it now returns only what the member may see.
9. **Owners and admins see the access as badges** on each field row in Settings ("Hidden from agents", "Agents: see only", "Hidden from viewers").

Changed files beyond section 9:
- `constants/customFields.js` (`AGENT_ACCESS`, `VIEWER_ACCESS`)
- `constants/approvals.js` (new)
- `routes/index.js` (`/approval-rules`)
- `Quotations.html` and `css/quotations.css` (approval box and filter)
- `js/custom-fields.js`, `js/settings-fields.js`, `Settings.html` (access choices)

No existing test was changed.

## 15. Scorecard results (measured 2026-10-21)

Measured in the isolated preview (port 3100, an in-memory database, the tests' sign-in); the real database was not used.

| # | Target | Result |
|---|---|---|
| 1 | A "discount above 10%" rule in ≤ 6 clicks | **Met: 4 clicks** (Approvals tab, Add rule, the discount box, Save rule). The name is typed into the box that is already focused. |
| 2 | 2 clicks from the bell to approved; the salesperson sees it within 5 s | **Missed by one click: 3 clicks** (the bell, the note, Approve), or 2 counting from an open bell. **Met: the salesperson's open page showed "Approved by …" after 3.4 s** without reloading, and Send and PDF came back. |
| 3 | 0 leaks of a hidden field | **Met: 0.** `tests/fieldAccess.test.js` checks get, list, viewer, page and global search, filters, link names, the CSV import, leads and records. In the browser, the agent saw neither the value nor the field. |
| 4 | No new failures | **Met.** Full run in the working folder: **845 tests, 844 passed**, including 25 new ones (`approvals.test.js` 16, `fieldAccess.test.js` 9). The one failure is the known Sales Automation text keys from the uncommitted Hindi work. |
| 5 | Mobile at 390 px | **Met.** The rule form, the approval box with Approve/Reject in the bottom bar, and the field access choices fit with no sideways scroll (page width 390 px). |
