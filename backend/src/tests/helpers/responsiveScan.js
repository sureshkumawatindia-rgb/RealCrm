const fs = require('fs');
const path = require('path');

// The responsive rules (R4, docs/RESPONSIVE_GUIDE.md), checked by reading the files. Used by
// tests/frontendResponsive.test.js. A rule that is broken on purpose carries a comment with
// "responsive-ok: <why>" inside the CSS rule (or on the same line in HTML and JS).

const FRONTEND = path.resolve(__dirname, '..', '..', '..', '..', 'crm', 'frontend');
// The user's own files (2026-10-24): scanned and listed in the guide, never failed on, never
// edited by the assistant.
const OWNER_FILES = new Set([
  'Sales Automation.html', 'Calendar.html', 'Marketing.html', 'accounts.html', 'Al Insights.html',
  'js/automation.js', 'js/marketing.js', 'js/marketing-broadcasts.js',
]);
const OK = /responsive-ok/;

const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');

// Every rule's selector and body, nested @media blocks included (the inner rules match).
function rulesOf(css) {
  const rules = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selector: match[1], body: match[2], line: lineAt(css, match.index + match[1].length) });
  }
  return rules;
}
const declarations = (body) => stripComments(body).split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
  const colon = d.indexOf(':');
  return { prop: d.slice(0, colon).trim().toLowerCase(), value: d.slice(colon + 1).trim() };
});
const cleanSelector = (selector) => stripComments(selector).trim().replace(/\s+/g, ' ');

const CSS_CHECKS = {
  // 1. Grid columns may shrink: "1fr" alone is minmax(auto, 1fr), as wide as its widest content.
  gridFr(rule) {
    return declarations(rule.body).some(({ prop, value }) => /^grid-(template|auto)-columns$/.test(prop)
      && /(^|[\s(,])\d*\.?\d+fr\b/.test(value.replace(/minmax\((?:[^()]|\([^()]*\))*\)/g, '')));
  },
  // 2. A growing input, textarea or select in a flex row needs min-width (else it never shrinks).
  flexInput(rule) {
    const selector = cleanSelector(rule.selector);
    if (!selector.split(',').some((part) => /(^|[\s>+~])(input|textarea|select)\b/.test(part.trim().split(' ').pop()))) return false;
    const decls = declarations(rule.body);
    const grows = decls.some(({ prop, value }) => (prop === 'flex' && /^\d*\.?\d+(\s|$)/.test(value) && Number.parseFloat(value) > 0) || (prop === 'flex-grow' && Number.parseFloat(value) > 0));
    return grows && !decls.some(({ prop }) => prop === 'min-width');
  },
  // 3. vh on phones includes the browser's bars: give the dvh value after it.
  viewportHeight(rule) {
    const decls = declarations(rule.body);
    return decls.some(({ prop, value }) => /(^|[^a-z\d.])\d*\.?\d+vh\b/.test(value)
      && !decls.some((other) => other.prop === prop && /\d+dvh\b/.test(other.value)));
  },
};

// 4. Something shown only on :hover needs a (hover: none) alternative for touch screens.
function hoverReveals(css, file) {
  const touchBlocks = [...css.matchAll(/@media[^{]*hover:\s*none[^{]*\{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  const found = [];
  for (const rule of rulesOf(css)) {
    const selector = cleanSelector(rule.selector);
    if (!selector.includes(':hover') || OK.test(rule.body) || OK.test(rule.selector)) continue;
    const reveals = declarations(rule.body).some(({ prop, value }) => (prop === 'opacity' && Number.parseFloat(value) >= 1)
      || (prop === 'visibility' && value === 'visible') || (prop === 'display' && value !== 'none'));
    if (!reveals) continue;
    const target = (selector.split(',')[0].split(' ').pop().match(/\.[\w-]+/g) || []).pop();
    if (target && touchBlocks.includes(target)) continue;
    found.push({ file, line: rule.line, rule: 'hoverReveal', text: selector });
  }
  return found;
}

function scanCss(file, css) {
  const found = [];
  for (const rule of rulesOf(css)) {
    if (OK.test(rule.body) || OK.test(rule.selector) || /^\s*@/.test(cleanSelector(rule.selector))) continue;
    for (const [name, check] of Object.entries(CSS_CHECKS)) {
      if (check(rule)) found.push({ file, line: rule.line, rule: name, text: `${cleanSelector(rule.selector)} { … }` });
    }
  }
  return [...found, ...hoverReveals(css, file)];
}

// 5 and 6: every page has a viewport meta; nothing wider than 320px is written inline.
function scanMarkup(file, text) {
  const found = [];
  if (file.endsWith('.html') && !/<meta[^>]+name="viewport"/.test(text)) found.push({ file, line: 1, rule: 'viewportMeta', text: 'no <meta name="viewport">' });
  for (const match of text.matchAll(/(?<![-\w])(?:min-)?width\s*:\s*(\d{3,})px/g)) {
    if (Number(match[1]) <= 320) continue;
    if (/\(\s*$/.test(text.slice(Math.max(0, match.index - 3), match.index))) continue; // a media query, e.g. matchMedia("(min-width: 861px)")
    const line = text.split('\n')[lineAt(text, match.index) - 1];
    if (OK.test(line)) continue;
    found.push({ file, line: lineAt(text, match.index), rule: 'inlineWidth', text: match[0] });
  }
  return found;
}

function filesOf() {
  const list = [];
  for (const name of fs.readdirSync(FRONTEND)) if (name.endsWith('.html')) list.push(name);
  for (const dir of ['css', 'js']) for (const name of fs.readdirSync(path.join(FRONTEND, dir))) if (/\.(css|js)$/.test(name)) list.push(`${dir}/${name}`);
  return list;
}

function scan() {
  const found = [];
  for (const file of filesOf()) {
    const text = fs.readFileSync(path.join(FRONTEND, file), 'utf8').replace(/\r\n/g, '\n');
    if (file.endsWith('.css')) found.push(...scanCss(file, text));
    else found.push(...scanMarkup(file, text));
    if (file.endsWith('.html')) {
      for (const style of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
        const offset = lineAt(text, style.index) - 1;
        found.push(...scanCss(file, style[1]).map((f) => ({ ...f, line: f.line + offset })));
      }
    }
  }
  return found;
}

module.exports = { scan, scanCss, scanMarkup, OWNER_FILES, FRONTEND };
