# Help inside the CRM (Phase 6, D118)

Phase 6 of the 100 phases (`HUNDRED_PHASES_PLAN.md`). Everyone gets short help in Hindi or
English on every page, a help centre with the common questions, and a WhatsApp button to the
platform's own support number.

## The "?" on each page

Next to the language and theme button at the top of every page (`app.js`, `crmHelp`). It opens a
box with the page's help: one line on what the page is for and its 1–4 most useful points, a
link to the same topic in the help centre (`help.html#topic-<topic>`) and, when the platform has
a support number, "Ask us on WhatsApp". The words and the box live in `js/help.js`, loaded the
first time "?" is pressed, so pages stay as light as before. Escape closes the box and puts the
keyboard back on "?".

A page without a topic of its own shows the general help and the help centre link.

## The help centre (`help.html`)

In the menu as "Help", right after Settings, for everyone. It has:

- **Talk to us:** the WhatsApp button, the support email and hours (only when the platform has
  them);
- **Get your CRM ready** (owners and admins): back to the dashboard's first-day list;
- **Common questions:** ten answers — connecting WhatsApp, importing old customers and leads,
  sending a quotation, getting paid, IndiaMART and website enquiries, adding staff, Hindi, the
  phone, the plan, and data safety;
- **Help for each page:** the 25 pages' help, each with a link to open the page.

The search keeps a question or a page only if every word typed is in it (its answer and points
too). `help.html#topic-leads` or `#faq-whatsapp` opens that one.

## The support number (platform admin → Support)

A platform admin sets the WhatsApp number, an email and the hours on the platform admin page's
**Support** tab (`GET/PUT /api/v1/platform/support`, behind its authenticator code). Ten digits
on their own are taken as Indian; the number is kept as `+91…`. An empty number hides the
WhatsApp button everywhere. The change is in the admin's own company's audit log
(`platform.support_updated`).

Every member reads it with `GET /api/v1/help/support` →
`{ whatsapp, email, hours, company: { name, code } }`. The number is the platform's, so it is
never hidden from agents (it is not a customer's number). The WhatsApp button opens
`wa.me/<number>` with a first message in the person's language that says the page and the
company's name and workspace code, so support knows who is asking and where.

## Writing help

Texts are in `crm/frontend/i18n/en.json` and `hi.json`:

| Key | What |
| --- | --- |
| `help.<topic>.intro` | One line: what the page is for |
| `help.<topic>.p1` … `pN` | The page's most useful points, short and in the page's own words |
| `help.faq.<id>.q` / `.a` | A common question and its answer |

A new page gets a line in `TOPICS` in `js/help.js` (its file, topic, icon and number of points)
and a `NAV_KEYS` name in `app.js`; a new question goes in `FAQ`. Only write what the page really
does: each point names the button or the place in Settings as the page shows it.

Tests: `backend/src/tests/help.test.js` (the contact: empty, set only by a platform admin with
the code, checked, read by every member unmasked) and the browser test `backend/e2e/help.spec.js`
(the "?" box and its topic, the help centre's search, and a number set on the platform admin page
turning into a WhatsApp button in another company's help). `e2e/texts.spec.js` opens the help
centre in Hindi with the texts held back.
