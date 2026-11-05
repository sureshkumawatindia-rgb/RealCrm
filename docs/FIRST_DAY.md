# The first day: "Get your CRM ready" and ready settings (Phase 5, D117)

Phase 5 of the 100 phases (`HUNDRED_PHASES_PLAN.md`). A new company's owner or admin sees on the
dashboard the first steps that make the CRM useful, and puts in ready settings made for their
kind of business with one click.

## The list: "Get your CRM ready"

On the dashboard, for owners and admins (agents and viewers never see it). Each step ticks itself
from the company's own data; nobody ticks it by hand. `GET /api/v1/organization/getting-started`
works the whole list out in one call.

| Step | Done when | Its button opens |
| --- | --- | --- |
| Business and GST details | the company has a GSTIN or an address | Settings → Company |
| Ready settings | a kit was chosen, or the company already has its own stages, a quick reply and quotation terms | the ready settings box |
| WhatsApp number | a WhatsApp number is connected | Connect WhatsApp |
| Products | the first product | Products |
| Leads | the first lead (added, imported from a file or from a lead source), or a lead source connected | Leads → Import |
| Team | someone else in the team, or an invitation waiting | Invite your team |
| First quotation | a quotation sent (anything past a draft) | a new quotation |

On a phone only the next step shows ("Show all 7 steps"). Once every step is done the card says
"Your CRM is ready 🎉" until it is closed.

"Hide this list" hides it for this person on every device
(`PATCH /organization/getting-started { hidden }`). Settings → Your Profile → "Show it on the
dashboard" brings it back (`dashboard.html?setup=1`). A list hidden in a browser before D117
stays hidden: the first visit moves that choice to the account.

## Ready settings for the business

Two kits in `backend/src/constants/businessKits.js`, each in English and Hindi:

| | Trader or wholesaler | Manufacturer |
| --- | --- | --- |
| Sales stages | New enquiry → Rate shared → Quotation sent → Negotiation | New enquiry → Requirement understood → Sample sent → Quotation sent → Waiting for PO |
| Follow-up after (days quiet) | 1–3 | 2–7 |
| Quick replies | `/rate` `/followup` `/moq` `/payment` `/dispatch` `/thanks` | `/catalogue` `/sample` `/moq` `/leadtime` `/payment` `/dispatch` `/thanks` |
| Quotation terms | ex-godown, GST extra, 100% advance, delivery in 3–5 working days | ex-works, GST/freight/insurance extra, 50% advance with the PO, production after the PO |
| A quotation is valid for | 7 days | 15 days |

Won and Lost end every pipeline. Each stage stands for one of the fixed stages (New, Contacted,
Quote Sent, Negotiation), so reports, automation and quotations work as before. Quick replies
use `{{contact.name}}` and `{{org.name}}`, which fill themselves; a `___` is for the person to
fill in before sending.

A kit never overwrites what the company set itself:

- **Stages:** set only while the default pipeline still has the stages every company starts
  with. They are renamed in place: each keeps its id, and so its leads. A manufacturer's
  "Sample sent" (a second Contacted stage) comes after "Requirement understood".
- **Quick replies:** only the shortcuts that are still free.
- **Terms:** only while the company has no quotation terms (with the days a quotation is valid).

The words are in the person's language: the box asks in the language the CRM is shown in, and
Hindi stage names are then the company's own names. Choosing a second kit later only adds what
is missing. Everything a kit does is in the audit log: `onboarding.kit_applied`, and the
pipeline, quick reply and billing entries it made.

API (owners and admins): `GET /organization/business-kits?language=en|hi` lists the kits in
that language and what the company keeps; `POST /organization/business-kit
{ kit: trader | manufacturer, language? }` returns
`{ kit, language, stages: set | kept, quickReplies: { added, kept }, terms: set | kept }`.

## Adding a kit

Add it to `KITS` in `constants/businessKits.js` with `name` and `about` (`en`, `hi`), `stages`
in order (each with `kind`, `name`, `probability`, `quietDays`), `quickReplies` (`shortcut`:
1–30 letters, digits, `-` or `_`; `title`, `body`), `terms` and `validityDays`. Give it an icon
in `js/dashboard.js` (`kitBox`, `ICONS`).

Tests: `backend/src/tests/gettingStarted.test.js` (the steps, hiding, both kits, never
overwriting, other companies untouched) and the browser test `backend/e2e/firstday.spec.js`
(the list, a kit in one click in English and in Hindi, the import box, hide and show again).
