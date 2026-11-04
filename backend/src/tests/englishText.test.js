const fs = require('fs');
const path = require('path');
const { scanHtml, scanJs, menuGaps, FRONTEND } = require('./helpers/englishText');
const { OWNER_FILES } = require('./helpers/responsiveScan');

// Phase 4 (D116, docs/HINDI_GUIDE.md): no English-only text comes back. Every text on a page and
// in a page script goes through i18n/en.json and hi.json; see helpers/englishText.js for what
// counts. The owner's own files are left to the owner; the legal pages stay in English.
const LEGAL = new Set(['privacy.html', 'terms.html']);
// The FAQ bot tab belongs to the owner's Sales Automation page, which the owner is putting into
// Hindi (round 3): left to the owner as well.
const OWNER_ROUND = new Set(['js/automation-bot.js']);
// Scripts whose texts are still to be put into Hindi (Phase 4 part B). A file comes off this list
// once it is done, and the test below makes sure a finished file is not left on it.
const NOT_YET = new Set([
  'js/accounts.js', 'js/ai-insights.js', 'js/platform-admin.js', 'js/settings-integrations.js',
  'js/settings-leadsources.js', 'js/settings-plan.js', 'js/settings-routing.js', 'js/settings.js', 'js/workflow-builder.js',
]);

const read = (file) => fs.readFileSync(path.join(FRONTEND, file), 'utf8');
const pages = fs.readdirSync(FRONTEND).filter((f) => f.endsWith('.html') && !OWNER_FILES.has(f) && !LEGAL.has(f));
const scripts = fs.readdirSync(path.join(FRONTEND, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`)
  .filter((f) => !OWNER_FILES.has(f) && !OWNER_ROUND.has(f));
const en = JSON.parse(read('i18n/en.json'));

describe('The English-text guard itself', () => {
  const htmlKinds = (html) => scanHtml(html).map((f) => f.kind);
  const jsTexts = (code) => scanJs(code).map((f) => f.text);

  it('finds English on a page, and lets texts with a Hindi key through', () => {
    expect(htmlKinds('<p>Hello there</p>')).toEqual(['text']);
    expect(htmlKinds('<p data-i18n="x.hello">Hello there</p>')).toEqual([]);
    expect(htmlKinds('<button><i class="fa-solid fa-plus"></i> <span data-i18n="x.add">Add a customer</span></button>')).toEqual([]);
    expect(htmlKinds('<button><i class="fa-solid fa-plus"></i> Add a customer</button>')).toEqual(['text']);
    expect(htmlKinds('<input placeholder="Search leads" />')).toEqual(['placeholder']);
    expect(htmlKinds('<input placeholder="Search leads" data-i18n-placeholder="x.search" />')).toEqual([]);
    expect(htmlKinds('<img src="a.png" alt="Code to scan" />')).toEqual(['alt']);
    expect(htmlKinds('<button title="Sound: on" data-i18n-js>x</button>')).toEqual([]);
    expect(htmlKinds('<code translate="no">Authorization: Bearer key</code>')).toEqual([]);
    expect(htmlKinds('<h1 data-hi="आप ऑफ़लाइन हैं">You are offline</h1>')).toEqual([]);
    expect(htmlKinds('<p>WhatsApp · GST · PDF · https://example.com · hello@example.com · order_update</p>')).toEqual([]);
    expect(htmlKinds('<aside class="sidebar"><a class="nav-item" href="leads.html">Leads</a></aside><title>Leads | YELLOW CRM</title>')).toEqual([]);
  });

  it('finds English in a script, and lets code, t() and the server\'s values through', () => {
    expect(jsTexts('showToast("Saved the customer", "success");')).toEqual(['Saved the customer']);
    expect(jsTexts('showToast(t("customers.saved"), "success");')).toEqual([]);
    expect(jsTexts('el.innerHTML = `<p>No customers yet</p>`;')).toEqual(['No customers yet']);
    expect(jsTexts('el.innerHTML = `<p>${escapeHtml(t("customers.empty"))}</p>`;')).toEqual([]);
    expect(jsTexts('document.querySelector(".bulk-check").classList.add("is-open");')).toEqual([]);
    expect(jsTexts('if (lead.stage === "Quote Sent") go();')).toEqual([]);
    expect(jsTexts('const stage = "Won";')).toEqual([]);
    expect(jsTexts('const keys = "Esc to close"; // i18n-ok: the keyboard\'s own key names')).toEqual([]);
    expect(jsTexts('el.className = "badge badge-neutral";')).toEqual([]);
  });
});

describe('No English-only text (Phase 4, D116)', () => {
  it.each(pages)('%s', (page) => {
    expect(scanHtml(read(page))).toEqual([]);
  });

  it.each(scripts.filter((f) => !NOT_YET.has(f)))('%s', (script) => {
    expect(scanJs(read(script))).toEqual([]);
  });

  it.each([...NOT_YET])('%s is still to do (take it off NOT_YET once it is in Hindi)', (script) => {
    expect(scanJs(read(script)).length).toBeGreaterThan(0);
  });

  it('names every page and group of the menu in the texts', () => {
    expect(menuGaps(en)).toEqual([]);
  });
});
