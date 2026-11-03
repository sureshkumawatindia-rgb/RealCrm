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
HTML template, escape it: `${escapeHtml(t("key"))}`.

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
  through `t()` fails. Code is left alone: selectors, class names, keys, API paths, CSS, the
  server's values, and the arguments of calls such as `querySelector` or `crmApi`. A line that
  keeps English on purpose says why: `// i18n-ok: the keyboard's own key names`.
- **The menu:** every page the sidebar opens has a `NAV_KEYS` name and every group a text.

Left alone on purpose:

- the legal pages (`privacy.html`, `terms.html`), which stay in English;
- the owner's own files: Marketing, Sales Automation, Team (accounts.html), AI Insights and
  Calendar pages and `js/automation.js`, `js/marketing.js`, `js/marketing-broadcasts.js`;
- the scripts still listed in `NOT_YET`. A finished script comes off the list. The test fails if a
  finished one is left on it.

`backend/src/tests/i18n.test.js` checks that every key a page or script uses exists, both files
have the same keys and placeholders, and Hindi is written in Devanagari.

## Status

**Part A (pages):** every page except the legal ones and the owner's is in Hindi. That includes
the whole Settings page, Reports, Team live, My performance, Platform admin, company setup, invite
team, link a device, and the 404 and offline pages. About 390 new texts.

**Part B (scripts):** the texts the scripts draw — Reports' numbers and tables, the Settings tabs'
lists and messages, AI Insights, boards, workflows and the rest. The guard's `NOT_YET` list shows
what is left.
