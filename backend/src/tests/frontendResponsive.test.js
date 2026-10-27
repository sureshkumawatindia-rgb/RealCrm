const { scan, scanCss, scanMarkup, OWNER_FILES } = require('./helpers/responsiveScan');

// The responsive rules (R4, docs/RESPONSIVE_GUIDE.md): what broke layouts on phones and tablets
// before, checked in every page, style and script. A rule broken on purpose says why with a
// "responsive-ok: <why>" comment. The user's own files are scanned but never failed on.

const rulesIn = (css) => scanCss('sample.css', css).map((f) => f.rule);

describe('The responsive guard itself', () => {
  it('catches each kind of mistake, and lets the right way through', () => {
    expect(rulesIn('.a { display: grid; grid-template-columns: 1fr 1fr; }')).toEqual(['gridFr']);
    expect(rulesIn('.a { grid-template-columns: repeat(7, 1fr); }')).toEqual(['gridFr']);
    expect(rulesIn('.a { grid-template-columns: repeat(7, minmax(0, 1fr)); }')).toEqual([]);
    expect(rulesIn('.a { grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); }')).toEqual([]);
    expect(rulesIn('.a { grid-template-columns: 38% minmax(0, 1fr) auto; }')).toEqual([]);
    expect(rulesIn('.row input { flex: 1; }')).toEqual(['flexInput']);
    expect(rulesIn('.row input { flex: 1 1 200px; min-width: 0; }')).toEqual([]);
    expect(rulesIn('.panel { height: 100vh; }')).toEqual(['viewportHeight']);
    expect(rulesIn('.panel { max-height: calc(100vh - 40px); max-height: calc(100dvh - 40px); }')).toEqual([]);
    expect(rulesIn('.msg:hover .reply { opacity: 1; }')).toEqual(['hoverReveal']);
    expect(rulesIn('.msg:hover .reply { opacity: 1; }\n@media (hover: none) {\n  .reply { opacity: 1; }\n}')).toEqual([]);
    expect(rulesIn('.a { grid-template-columns: 1fr 1fr; /* responsive-ok: two fixed icons */ }')).toEqual([]);
    expect(scanMarkup('page.html', '<html><head></head></html>').map((f) => f.rule)).toEqual(['viewportMeta']);
    expect(scanMarkup('page.js', 'el.style.cssText = "min-width: 480px";').map((f) => f.rule)).toEqual(['inlineWidth']);
    expect(scanMarkup('page.js', 'matchMedia("(min-width: 861px)")')).toEqual([]);
    expect(scanMarkup('page.js', 'el.style.maxWidth = "max-width: 720px"')).toEqual([]);
  });
});

const found = scan();
const show = (list) => list.map((f) => `${f.file}:${f.line} ${f.text}`);
const RULES = {
  gridFr: 'grid columns use minmax(0, …), never a bare 1fr',
  flexInput: 'a growing input, textarea or select in a flex row has min-width',
  viewportHeight: '100vh is followed by its 100dvh value',
  hoverReveal: 'nothing appears only on :hover without a (hover: none) alternative',
  viewportMeta: 'every page has a viewport meta tag',
  inlineWidth: 'no inline width or min-width over 320px in pages and scripts',
};

describe('Responsive rules in every page, style and script', () => {
  it.each(Object.entries(RULES))('%s: %s', (rule) => {
    expect(show(found.filter((f) => f.rule === rule && !OWNER_FILES.has(f.file)))).toEqual([]);
  });
});
