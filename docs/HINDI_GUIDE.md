# Hindi everywhere: how the CRM's texts work, and the guard (Phase 4, D116)

Phase 4 of the 100 phases (`HUNDRED_PHASES_PLAN.md`). Every text a person reads in the CRM comes
from `crm/frontend/i18n/en.json` and `hi.json`. The person's language is saved on their account
(Settings → Your Profile). A test stops English-only text from coming back.

## Adding a text

**On a page (HTML).** Give the element a key and put the key in both files:

| What | How |
| --- | --- |
| A whole element's text | `<label data-i18n="leads.full-name">Full Name</label>` |
| Text next to an icon or a field | `<i class="fa-solid fa-plus"></i> <span data-i18n="leads.new-lead">New Lead</span>` |
| A sentence with `<strong>`, `<a>` or `<code>` inside | `data-i18n-html="…"`. Our own texts only, never a customer's data. The Hindi keeps the same tags. |
| Placeholder, tooltip, screen-reader label, image text | `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-aria-label`, `data-i18n-alt` |
| An element whose text the page's script sets | `data-i18n-js`. The script sets it with `t()`. |
| Code, or a language's own name | `translate="no"` (e.g. `Authorization: Bearer …`, "English" in the language picker) |
| A page without scripts (`404.html`, `offline.html`) | `data-hi="…"` on the element. A small script on that page swaps it in. |

The menu is translated by `app.js` (`NAV_KEYS`, and `nav.group.<name>` for its groups). A new page
gets its `NAV_KEYS` line. The browser tab's title follows the page's heading.

**In a script.** Use `t("key")` or `t("key", { n: 3 })` with `{n}` in both texts. Put it inside the
function that draws the page, never at load time: the texts arrive with `crmI18n.ready`. Inside an
HTML template, escape it: `${escapeHtml(t("key"))}`, tooltips and placeholders too
(`title="${escapeHtml(t("key"))}"`).

- **When it draws.** An answer from the server (`crmApi`, `crmRequest`) reaches the page only after
  the texts are in, so a list drawn from it is safe. Something drawn at load time without the
  server waits: `crmI18n.ready.then(drawIt)`.
- **One and many.** Two keys, `….one` and `….many`, and the count picks one:
  `t(n === 1 ? "x.leads.one" : "x.leads.many", { n })` ("1 lead", "2 leads"; Hindi often says the
  same in both). Never `lead${n === 1 ? "" : "s"}`.
- **A whole sentence, one key.** Hindi puts words in another order, so a sentence with a value in
  it is one text with `{name}` in it, not pieces around the value. A space at the start or end
  (`" · last {when}"`) is in both texts.
- **A table of labels at load time** (badges, kinds, steps) holds keys, and the drawing calls
  `t(label)`.
- `tr("key", "English")` (Workflow builder) is `t()` with an English fallback, for keys built from
  the server's own types.

The server's own values stay English and are shown with `crmLabel("stage", lead.stage)`:
stages, statuses, sources and roles.

**The texts.** Every key is in both files, sorted. The Hindi is in Devanagari (names such as
WhatsApp, GST, IndiaMART and Google stay as they are). Placeholders match: `{name}` in one means
`{name}` in the other. A WhatsApp variable that is shown to the person as it is, such as `{{1}}`,
stays as it is.

## The guard

`backend/src/tests/englishText.test.js` (helper: `src/tests/helpers/englishText.js`) reads every
page and script.

- **Pages:** a visible text, placeholder, title, aria-label or alt with English words and none of
  the marks above fails.
- **Scripts:** a string or template text that reads as words on the screen and does not go
  through `t()` (or `tr()`) fails, and so does a tooltip, placeholder, aria-label or alt in a
  script's markup or `setAttribute("title", …)`. Code is left alone: selectors, class names, keys,
  API paths, CSS, the server's values, and the arguments of calls such as `querySelector` or
  `crmApi`. A line that keeps English on purpose says why: `// i18n-ok: the keyboard's own key
  names`. The guard does not see one lowercase word (`"never"`, `"ends"`) or a plural made with
  `"s"`: look for those by eye.
- **The menu:** every page the sidebar opens has a `NAV_KEYS` name and every group a text.

Left alone on purpose:

- the legal pages (`privacy.html`, `terms.html`), which stay in English;
- the owner's own files: Marketing, Sales Automation, Team (accounts.html), AI Insights and
  Calendar pages and `js/automation.js`, `js/marketing.js`, `js/marketing-broadcasts.js`, and
  the FAQ bot tab of Sales Automation (`js/automation-bot.js`). The scripts of the Team and AI
  Insights pages (`js/accounts.js`, `js/ai-insights.js`) are in Hindi; those pages' own HTML is
  the owner's.

`backend/src/tests/i18n.test.js` checks that every key a page or script uses exists (with `t`,
`crmI18n.t`, `lt` and `tr`), both files have the same keys and placeholders, and Hindi is written
in Devanagari.

`backend/e2e/texts.spec.js` (with `npm run e2e`) opens 20 pages and every Settings tab in Hindi
with the texts held back 1.5 seconds: no page may show a key such as `setls.none`.

## Status

**Part A (pages):** every page except the legal ones and the owner's is in Hindi. That includes
the whole Settings page, Reports, Team live, My performance, Platform admin, company setup, invite
team, link a device, and the 404 and offline pages. About 390 new texts.

**Part B (scripts):** done. Every script the guard reads draws its texts through `t()`: Reports'
numbers and tables, every Settings tab (lead sources, lead rules, plan, integrations, team, data
…), the Inbox, Quotations, Team live, Support, Workflow builder, the Team page's wizard and cards,
Platform admin, and AI Insights, whose "Ask" box also understands Hindi and Hinglish questions
("kitna paisa baki hai"). 1,413 new texts in all: 386 for the pages, 1,027 for the scripts.

Still in English, on purpose or for later:

- what the server writes itself: plan features and usage names, audit actions, the go-live
  checklist, error reasons and a customer's own data;
- dates on some pages (`en-IN`: English month names);
- the amount in words on quotations and invoices, as on GST documents;
- the website code a customer copies (the plain HTML form), in the website's own words;
- the owner's pages listed above.
