# Responsive guide

How agreem360 stays usable from a 320px phone to a 1440px screen, in English and Hindi, in
light and dark mode, with a mouse or a finger. Written for R4 of the responsive fix plan
(D97–D98, 2026-10-27). The plan itself is `docs/RESPONSIVE_FIX_PROMPT.md`.

The mobile layer lives in `crm/frontend/css/style.css` ("PHONES AND TABLETS": 860px menu
slide-in, 600px cards and bottom-sheet popups, 360px) and `crm/frontend/js/app.js`
(`initSidebarToggle`, `initTableCards`, `watchTabBars`). Each page's own CSS loads after
`style.css`.

## The ten rules

1. **Grid columns can shrink.** Write `minmax(0, 1fr)`, never a bare `1fr` (a bare `1fr` is
   `minmax(auto, 1fr)`: as wide as its widest content, so one long email widens the grid).
   `repeat(3, minmax(0, 1fr))`, `38% minmax(0, 1fr)`, `minmax(0, 1fr) auto`. Auto-fill grids
   keep `repeat(auto-fill, minmax(min(100%, 220px), 1fr))`.
2. **Growing inputs can shrink.** An input, textarea, select or long text in a flex row gets
   `min-width: 0` next to its `flex: 1`.
3. **Long words wrap.** Emails, URLs, GSTINs, phone numbers and names get
   `overflow-wrap: anywhere`, or `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`
   when they must stay on one line (with the full text in `title`).
4. **No fixed width over 320px** outside a media query or a side-scrolling container
   (a table's panel, a tab bar). This includes inline `style=""` in pages and in JS templates.
5. **`vh` has a `dvh` twin.** On phones `100vh` includes the browser's bars, so a popup cut to
   `70vh` hides its Save button. Write the `vh` line first (old browsers) and the `dvh` line
   after it:
   ```css
   max-height: calc(100vh - 48px);
   max-height: calc(100dvh - 48px);
   ```
6. **Nothing only on hover.** A button that appears on `:hover` is always visible on touch:
   repeat the reveal inside `@media (hover: none)` (see the one in `style.css`).
7. **Tap targets are 40px on touch.** Raise buttons, chips and links inside
   `@media (pointer: coarse)` (or `(max-width: 1100px) and (pointer: coarse)` for tablets) so
   the mouse layout stays compact.
8. **Closed panels are gone.** An off-screen drawer or sheet gets `visibility: hidden` and the
   `inert` property while closed (the Inbox details sheet in `inbox.js` is the example), so
   it cannot be tabbed into and does not stretch the page.
9. **Tab bars scroll at every width.** Add new tab bars to the shared rule in `style.css`
   (`.report-tabs`, `.o-tabs`, `.c360-tabs`, …): one line, side-scroll, a fade on the side with
   more tabs (`watchTabBars` sets `data-scroll`). Hindi labels are longer; check them.
10. **Check every new page or feature** at 320, 375, 768, 1024 and 1440px, in Hindi and in dark
    mode, with long test data (below), before it is merged.

Colors on counts: white digits sit on `--wa-badge` (#158a45, 4.4:1; the WhatsApp green #25d366
was 1.98:1) for unread counts and on `--badge-danger` (#ff453a light, #e5484d dark, 3.9:1) for
the bell. New badges use these, never `--wa` or `--danger` directly.

## The guard test

`backend/src/tests/frontendResponsive.test.js` reads every `crm/frontend/*.html` (inline
`<style>` blocks included), `css/*.css` and `js/*.js`, with no browser and no new dependency.
The scanner is `backend/src/tests/helpers/responsiveScan.js`. It runs with the other tests in
CI (`npm test` in `backend`), or alone:

```bash
npx jest src/tests/frontendResponsive.test.js
```

It fails, with `file:line` for each place, when:

| Check | Rule | What it flags |
| --- | --- | --- |
| `gridFr` | 1 | `grid-template-columns` / `grid-auto-columns` with an `fr` outside `minmax(…)`, e.g. `1fr 1fr`, `repeat(7, 1fr)` |
| `flexInput` | 2 | a selector ending in `input`, `textarea` or `select` with `flex: 1` (or `flex-grow`) and no `min-width` |
| `viewportHeight` | 5 | a `vh` value with no `dvh` value for the same property in the same rule |
| `hoverReveal` | 6 | a `:hover` rule that sets `opacity: 1`, `visibility: visible` or a `display`, when its class is not in a `@media (hover: none)` block of the same file |
| `viewportMeta` | — | an `.html` page without `<meta name="viewport">` |
| `inlineWidth` | 4 | `width:` or `min-width:` over 320px in an `.html` page or a `.js` file (media queries such as `matchMedia("(min-width: 861px)")` are skipped; `max-width` is fine) |

The first test feeds the scanner a bad and a good sample of each check, so a broken scanner
fails too.

**On purpose?** Put `responsive-ok: <why>` in a comment. In CSS it goes inside the rule's
braces; in HTML and JS on the same line. Always give the reason.

```css
.dial-keys {
  grid-template-columns: repeat(3, 1fr); /* responsive-ok: three one-digit keys, never long */
}
```

```js
row.innerHTML = `<div style="min-width: 640px">${cells}</div>`; // responsive-ok: inside the import table, which scrolls sideways
```

No place in the code needed one on 2026-10-27.

**The user's own files** (`Sales Automation.html`, `Calendar.html`, `Marketing.html`,
`accounts.html`, `Al Insights.html`, `js/automation.js`, `js/marketing.js`,
`js/marketing-broadcasts.js`) are scanned but never fail the test, and the assistant does not
edit them. On 2026-10-27 the scanner found nothing in them. To list what it finds there now:

```bash
node -e "const s=require('./src/tests/helpers/responsiveScan');console.table(s.scan().filter((f)=>s.OWNER_FILES.has(f.file)))"
```

**What it cannot see:** rules 3, 7, 8, 9 and 10 depend on real text, real sizes and real state.
Use the console check below and the device checklist. A browser test (Playwright or Puppeteer)
would cover them, but it is a new, large dependency: ask the user first.

## Console check (any page, any width)

Open DevTools, switch on device mode (touch on for tap targets), pick a width, open the page's
tabs and popups one by one, and paste this in the console:

```js
(() => {
  const vw = document.documentElement.clientWidth;
  const name = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "")
    + [...el.classList].slice(0, 2).map((c) => `.${c}`).join("");
  const shown = (el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden"
    && !el.closest("[inert], [hidden]");
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(p).overflowX)) return true;
    }
    return false;
  };
  const touch = matchMedia("(pointer: coarse)").matches;
  const offScreen = new Set(); const clipped = []; const small = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if ((r.right > vw + 1 || r.left < -1) && !offScreen.has(el.parentElement) && !inScroller(el)) offScreen.add(el);
    if (cs.overflowX === "hidden" && cs.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 1) {
      clipped.push(`${name(el)}: ${el.scrollWidth}px of content in ${el.clientWidth}px`);
    }
    if (touch && el.matches('a[href], button, [role="button"], select, input:not([type="hidden"])')
      && (r.width < 40 || r.height < 40)) small.push(`${name(el)}: ${Math.round(r.width)}×${Math.round(r.height)}`);
  }
  console.log(`width ${vw}px, page ${document.documentElement.scrollWidth}px wide`
    + (document.documentElement.scrollWidth > vw ? "  <-- scrolls sideways" : ""));
  console.log("off screen:", [...offScreen].map((el) => {
    const r = el.getBoundingClientRect();
    return `${name(el)}: ${Math.round(r.left)}..${Math.round(r.right)}px`;
  }));
  console.log("cut off:", clipped);
  console.log(touch ? "tap targets under 40px:" : "tap targets: switch on touch in device mode", small);
})();
```

All three lists empty and the page as wide as the screen means the page passes at that width.
A tiny checkbox inside a 40px label is fine; the label is the target.

## How the audit was measured (D97, 2026-10-27)

- An isolated copy of the app on port 3100 with the in-memory MongoDB the tests use, never real
  data. Test data with long text everywhere: a 90-character email with no spaces, long names,
  company, event, product and project titles, a WhatsApp chat.
- All 37 pages, each in same-origin iframes at 12 widths: 320, 360, 375, 390, 414, 768, 820,
  880, 960, 1024, 1280 and 1440px. On each page its tabs, Add/New popups, detail drawers, the
  bell, search and the "New" menu were opened and measured too.
- Checked: the page's `scrollWidth` against the screen; every shown element against the screen
  and against its grid cell (side-scrolling containers and closed, hidden drawers skipped);
  content cut by `overflow: hidden`; text against its background under 3:1 in dark mode
  (a gradient counts as its first color); tap targets under 40px with `pointer: coarse`.
- Every page again in Hindi and in dark mode.
- Pitfalls: CSS animations do not run while the browser pane is hidden, so they were switched
  off before measuring (a popup 32px low is not a bug). The session token lasts 15 minutes and
  logins are rate-limited, so each batch logged in fresh and recorded the page it actually
  landed on (a page that bounced to login is not a pass).
- R4 (2026-10-27): after the guard's fixes (45 lines in 17 files: `minmax(0, …)`, `dvh` twins,
  `min-width: 0`), the 16 pages they touch were measured again at 320, 768 and 1024px: no page wider
  than the screen and nothing outside its grid cell, apart from closed drawers (hidden + inert).

## Real devices

Emulation misses the browser's own bars, the keyboard and the notch. Before a release, on each
device, in English and Hindi, light and dark:

**Android phone, Chrome (360–412px)**
- [ ] Login, dashboard, Leads, Inbox, Orders, Settings: nothing scrolls sideways.
- [ ] Open a popup and tap its last input: the keyboard does not hide the Save button.
- [ ] Inputs do not zoom the page when tapped (they are 16px on touch).
- [ ] The back button closes the Inbox details sheet before leaving the page.
- [ ] Inbox: reply to a message by touch, record and send a voice note, the reply timer shows.

**iPhone, Safari (375–430px)**
- [ ] Popups and the Inbox composer stay above the bottom bar when it shows and hides (`dvh`).
- [ ] The keyboard on a popup leaves Save visible (the app has no `visualViewport` handling yet; if Save hides, that is the fix).
- [ ] Hover-only controls (reply, Move to…, row actions) are visible without a mouse.
- [ ] Nothing sits under the notch or the home bar.

**iPad, Safari (768, 820 and 1024px, portrait and landscape)**
- [ ] Inbox tablet mode: list and thread side by side, the details sheet opens and closes.
- [ ] The menu, tab bars and Kanban boards work without hover.
- [ ] Rotating keeps the open page, popup and scroll position usable.

**Installed app (PWA: Android "Add to Home screen", iPhone Share → Add to Home Screen)**
- [ ] Opens full screen; the top bar does not sit under the status bar.
- [ ] Turning the network off shows `offline.html`, and the app comes back when it returns.
- [ ] WhatsApp and phone-call links open the right app.
