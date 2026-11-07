# End-to-end browser tests: the ten flows that must never break (Phase 2, D114)

Phase 2 of the 100 phases (`HUNDRED_PHASES_PLAN.md`). A real browser (Chromium, via
Playwright) clicks through the CRM's own screens the way a trader's first day goes. Each flow
builds on the one before:

1. **Sign up.** A new owner skips "Invite your team", fills the company details (GSTIN, address,
   city, state, PIN) and lands on the dashboard.
2. **A test WhatsApp number.** Settings → WhatsApp → developer tools → add a test number.
3. **A customer writes.** The message simulator sends a WhatsApp message; the customer appears in
   Leads.
4. **The reply.** The Inbox opens the chat and a reply goes out.
5. **The quotation.** It is made for the customer with one line (2 × ₹6,250, GST 5%), saved,
   marked sent and accepted.
6. **The order.** The accepted quotation becomes an order.
7. **The tax invoice.** The order gets its GST tax invoice.
8. **The payment.** ₹13,125 is recorded and the order shows as paid.
9. **The report.** Reports & Analytics counts the ₹13,125.
10. **A teammate.** An agent is invited in Settings → Team, signs in with the invite and works in
    the Inbox.

A script error on any page also fails the flow it happened in.

Next to the flows, `backend/e2e/texts.spec.js` (Phase 4, D116, `HINDI_GUIDE.md`) opens 21 pages
and the 19 Settings tabs in Hindi with the texts held back 1.5 seconds: a page that shows a
text's key (such as `setls.none`) instead of its words fails. It adds about two minutes.

`backend/e2e/firstday.spec.js` (Phase 5, D117, `FIRST_DAY.md`) is a new owner's first day: the
"Get your CRM ready" list with its seven steps, a manufacturer's ready settings in one click (and
a trader's in Hindi), the leads step opening the import box, and the list hidden and brought back
from Settings → Your Profile.

`backend/e2e/help.spec.js` (Phase 6, D118, `HELP.md`): a page's "?" box and its topic in the help
centre, the help centre's search, and a support number set on the platform admin page (unlocked
with a backup code) becoming a WhatsApp button in another company's help.

`backend/e2e/phone.spec.js` (Phase 7, D119, `PHONE_APP.md`), on a Pixel 7 in Hindi with the
service worker on: installable with the files kept on the phone; the Inbox with no network (the
saved list, a chat read before, one of the newest); a reply written offline goes once the network
is back (and the live updates reconnect); a reply whose answer was lost on the way goes once (the
server's copy checked); a reply that waited more than a day waits for the person; signing out asks
about a waiting reply, then leaves nothing on the phone.
Every other spec runs with the service worker off (`serviceWorkers: 'block'` in
`playwright.config.js`): they test the pages as the server sends them.

## Where it runs

- **On GitHub, on every push**, as the job "The ten flows in a browser"
  (`.github/workflows/tests.yml`), next to the backend tests. Render deploys `main` only when
  every check passes, so a broken flow never goes live.
- When a flow fails on GitHub, open the run → **Artifacts → e2e-results**. It holds what the
  browser saw: a screenshot, a video and a trace. The trace opens on
  [trace.playwright.dev](https://trace.playwright.dev): drop the zip on the page.
- **On a developer's computer:** run `npm run e2e` in `backend/`. The first time, install the
  browser once with `npx playwright install chromium`.

## What it runs against

`backend/e2e/server.js` starts the real CRM with:

- an in-memory MongoDB;
- the test Google sign-in (`test:<sub>:<email>:<name>`);
- the developer tools (test WhatsApp numbers, the message simulator);
- its own port (3200).

It never reads `backend/.env`, and never reaches the real database, Meta or a payment gateway.
Files go to a temporary folder that is removed afterwards.

Sign-in uses the same Google sign-in call the login page makes after Google's button, so the
tests never type into Google.

## Adding a flow

Put it in `backend/e2e/flows.spec.js`, in the order a business would do it, using the page's
element ids (`#…`, `[data-action="…"]`). When a screen's ids change, change the flow in the same
commit.
