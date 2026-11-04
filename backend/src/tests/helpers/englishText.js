const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

// English-only text on the pages (Phase 4, D116, docs/HINDI_GUIDE.md), found by reading the files.
// Used by tests/englishText.test.js.
//   Pages: every visible text, placeholder, title, aria-label and alt with English words carries
//   data-i18n (or -html, -placeholder, -title, -aria-label, -alt). data-i18n-js marks an element
//   whose texts its script sets with t(); translate="no" keeps code or a language's own name as it
//   is; data-hi gives a page without scripts (404, offline) its Hindi. The menu is translated by
//   app.js (NAV_KEYS), so the sidebar is skipped here and checked on its own.
//   Scripts: string and template texts that read as words on the screen and are not passed
//   through t() (or tr(key, English), t() with a fallback). The server's own values (stages,
//   statuses, sources, roles …) stay English and are shown with crmLabel(). Tooltips and
//   placeholders in a script's markup count too. A line that keeps English on purpose says why
//   with "i18n-ok: <why>".

const FRONTEND = path.resolve(__dirname, '..', '..', '..', '..', 'crm', 'frontend');
const CONSTANTS = path.resolve(__dirname, '..', '..', 'constants');
const OK = /i18n-ok/;

// Words that stay as they are in Hindi: names, formats, units, abbreviations.
const KEEP = new Set([
  'yellow', 'crm', 'whatsapp', 'gst', 'gstin', 'pan', 'pdf', 'csv', 'excel', 'upi', 'otp', 'qr', 'api', 'url', 'id', 'indiamart',
  'justdial', 'tradeindia', 'google', 'gmail', 'meta', 'facebook', 'instagram', 'messenger', 'razorpay', 'cashfree', 'phonepe',
  'paytm', 'tally', 'microsoft', 'outlook', 'teams', 'sms', 'ifsc', 'hsn', 'sac', 'moq', 'sku', 'kb', 'mb', 'gb', 'rs', 'inr', 'am',
  'pm', 'ok', 'ai', 'html', 'json', 'xml', 'ist', 'utc', 'lr', 'tds', 'tcs', 'neft', 'rtgs', 'imps', 'dnd', 'sla', 'csat', 'kpi', 'fy',
  'exotel', 'zapier', 'claude', 'anthropic', 'opus', 'webm', 'mp4', 'cgst', 'sgst', 'igst', 'utgst', 'cess',
]);
// Addresses, emails, domains and names_with_underscores are not words to translate.
const NOT_WORDS = /https?:\/\/\S+|[\w.+-]+@[\w-]+(\.[\w-]+)+|\b[\w-]+(\.[\w-]+)*\.(com|in|net|org|io|co|app|dev)\b\S*|\b\w*_\w*\b|&[a-z]+;|&#\d+;/gi;
function englishWords(text) {
  const words = String(text).replace(NOT_WORDS, ' ').match(/[A-Za-z][A-Za-z'’-]*/g) || [];
  // "e.g. 50": its words are too short to count, but it is English all the same.
  return [...(/\be\.g\./i.test(text) ? ['e.g.'] : []), ...words.filter((w) => w.length >= 2 && !KEEP.has(w.toLowerCase()))];
}

// --- pages ------------------------------------------------------------------------------------
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];
function scanHtml(html) {
  const page = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<![^>]*>/g, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<aside class="sidebar"[\s\S]*?<\/aside>/gi, '').replace(/<title>[\s\S]*?<\/title>/gi, '');
  const found = [];
  const stack = []; // { tag, covered }
  const tokens = /<\/?([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let m;
  while ((m = tokens.exec(page))) {
    if (m[3] !== undefined) {
      const text = m[3].replace(/\s+/g, ' ').trim();
      if (text && !stack.some((s) => s.covered) && englishWords(text).length) found.push({ kind: 'text', text });
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    if (m[0].startsWith('</')) {
      const at = stack.map((s) => s.tag).lastIndexOf(tag);
      if (at >= 0) stack.splice(at);
      continue;
    }
    const has = (name) => new RegExp(`(?:^|\\s)${name}(?:=|\\s|$)`).test(attrs);
    const free = has('data-i18n-js') || /(?:^|\s)translate="no"/.test(attrs) || has('data-hi');
    for (const name of ATTRIBUTES) {
      const value = (attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`)) || [])[1];
      if (value && englishWords(value).length && !has(`data-i18n-${name}`) && !free) found.push({ kind: name, text: value });
    }
    if (!VOID.has(tag) && !attrs.trim().endsWith('/')) stack.push({ tag, covered: has('data-i18n') || has('data-i18n-html') || free });
  }
  return found;
}

// --- scripts ----------------------------------------------------------------------------------
// The server's own values, from backend/src/constants: shown through crmLabel(), kept in English.
const DOMAIN = new Set(['Owner', 'Admin', 'Agent', 'Viewer', 'To Do', 'In Progress', 'Done', 'Low', 'Medium', 'High', 'Urgent']);
for (const file of fs.readdirSync(CONSTANTS).filter((f) => f.endsWith('.js'))) {
  const exported = require(path.join(CONSTANTS, file)); // eslint-disable-line global-require, import/no-dynamic-require
  for (const value of Object.values(exported)) {
    const list = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value).flat() : [];
    list.filter((v) => typeof v === 'string').forEach((v) => DOMAIN.add(v));
  }
}
// Calls whose string arguments are code: selectors, events, storage keys, API paths, keys of t().
const CODE_CALLS = new Set([
  'querySelector', 'querySelectorAll', 'getElementById', 'closest', 'matches', 'addEventListener', 'removeEventListener', 'setAttribute',
  'getAttribute', 'removeAttribute', 'hasAttribute', 'toggleAttribute', 'add', 'remove', 'toggle', 'contains', 'replace', 'replaceAll',
  'createElement', 'dispatchEvent', 'getItem', 'setItem', 'removeItem', 'getPreference', 'setPreference', 'crmApi', 'crmRequest',
  'crmFetchAll', 'crmFetchPages', 'crmDownload', 'fetch', 'log', 'warn', 'error', 'info', 'debug', 't', 'lt', 'tr', 'btr', 'has', 'crmLabel',
  'postMessage', 'Event', 'CustomEvent', 'URL', 'URLSearchParams', 'RegExp', 'get', 'set', 'append', 'delete', 'includes',
  'startsWith', 'endsWith', 'split', 'join', 'indexOf', 'padStart', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString',
  'DateTimeFormat', 'NumberFormat', 'insertAdjacentHTML', 'cfFields', 'crmLoad', 'crmReady', 'jsonRequest', 'on', 'off', 'emit',
  'send', 'open', 'register', 'matchMedia', 'require', 'crmRecord', 'crmServerList', 'crmBulkBar', 'cfFilterBar', 'cfExportButton',
]);
const CLASS_WORD = /^(?:fa|btn|badge|stat|card|icon|is|has|text|q|c360|crm|bulk|mini|deal|lead|row|col|empty|inline|link|nav|tab|chip|pill|tag|kpi|panel|modal|form|input|label|list|item|table|cell|head|sub|muted|active|open|hidden|show|hide|primary|outline|danger|success|warning|info|neutral|sm|lg|xs|solid|regular|brands)/;
function looksLikeCode(text) {
  const s = text.trim();
  if (!s) return true;
  if (/^[\w.-]+$/.test(s) && !/^[A-Z][a-z]+[.!?]?$/.test(s)) return true; // identifiers, keys, class names, lowercase words
  if (/^[#.[:]/.test(s) || /^(?:https?:|mailto:|tel:|data:)/.test(s) || /^\/\S*$/.test(s)) return true; // selectors, links, paths ("/month + GST" is words)
  if (/\.html?(?:[?#]|$)/.test(s)) return true; // page names ("Reports & Analytics.html")
  if (/^[a-z]+(?:\s*,\s*[a-z]+)+$/.test(s)) return true; // selector lists ("input, textarea, select")
  if (/^(?:checked|disabled|selected|hidden|readonly|required|multiple)(?:\s+(?:checked|disabled|selected|hidden|readonly|required|multiple))*$/.test(s)) return true; // attributes
  if (/^[\w-]+(?:="[^"]*")?(?:\s+[\w-]+(?:="[^"]*")?)*$/.test(s) && /="/.test(s)) return true; // attributes ('disabled aria-current="true"')
  if (/^\S*[:/(=]\S*$/.test(s) || /^var\(|^\(prefers|^\((?:min|max)-width/.test(s)) return true; // CSS, MIME types, keys
  if (/^[a-z0-9 _-]+$/.test(s) && /-/.test(s)) return true; // class lists
  if (/^[a-z]+(?:\s+[a-z-]+)*$/.test(s) && s.split(/\s+/).every((w) => CLASS_WORD.test(w))) return true;
  return false;
}
const visible = (raw) => raw.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ').replace(/\s+/g, ' ').trim();
// The words markup in a script shows in its own attributes (a tooltip, a placeholder); the parts
// around a ${…} value one by one.
const attributeTexts = (markup) => [...markup.matchAll(/\s(?:placeholder|title|aria-label|alt)="([^"]*)"/g)].flatMap((m) => m[1].split('\u0000'));
// One such text is code when it is a single token (a unit, a code, an example address) or a link.
const attributeIsCode = (s) => (/^\S+$/.test(s) && !/^[A-Z][a-z]+[.!?]?$/.test(s)) || /^(?:https?:|mailto:|tel:|\/)/.test(s);
function scanJs(code) {
  const ast = parser.parse(code, { sourceType: 'script', errorRecovery: true, allowReturnOutsideFunction: true });
  const lines = code.split('\n');
  const found = [];
  const visit = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') return;
    let pieces = null;
    let attributes = [];
    if (node.type === 'StringLiteral') {
      pieces = DOMAIN.has(node.value) ? [] : [node.value];
      attributes = attributeTexts(node.value);
    }
    // A template: its tags may span ${…} parts, so they are taken out of the whole first. One that
    // starts like a selector (".a[data-x=…]") is code; keys (<kbd>) and elements marked
    // translate="no" keep their own words.
    if (node.type === 'TemplateLiteral') {
      const whole = node.quasis.map((q) => q.value.cooked || '').join('\u0000');
      const selector = /^[.#[]/.test((node.quasis[0].value.cooked || '').trim());
      pieces = selector ? [] : whole.replace(/<kbd>[^<]*<\/kbd>/g, ' ').replace(/<(\w+)\b[^>]*\btranslate="no"[^>]*>[^<]*<\/\1>/g, ' ')
        .replace(/<[^>]*>/g, ' ').split('\u0000');
      attributes = selector ? [] : attributeTexts(whole);
    }
    if (pieces) {
      const callee = parent && /^(?:Optional)?CallExpression$/.test(parent.type) && key === 'arguments' ? parent.callee : null;
      const calleeName = callee ? (callee.type === 'Identifier' ? callee.name : callee.property && callee.property.name) : '';
      // setAttribute("title", "…") shows its second argument.
      const shown = calleeName === 'setAttribute' && parent.arguments[1] === node && ATTRIBUTES.includes(parent.arguments[0]?.value);
      const skip = (CODE_CALLS.has(calleeName) && !shown)
        || (parent && parent.type === 'ObjectProperty' && key === 'key')
        || (parent && parent.type === 'BinaryExpression' && /^(?:[!=]==?|in)$/.test(parent.operator))
        || (parent && parent.type === 'SwitchCase')
        || OK.test(lines[node.loc.start.line - 1] || '');
      if (!skip) {
        for (const piece of pieces) {
          const text = visible(piece);
          if (text && !looksLikeCode(piece) && englishWords(text).length) found.push({ kind: 'js', line: node.loc.start.line, text: text.slice(0, 120) });
        }
        for (const value of attributes) {
          const text = value.replace(/\s+/g, ' ').trim();
          if (text && !attributeIsCode(text) && englishWords(text).length) found.push({ kind: 'js', line: node.loc.start.line, text: text.slice(0, 120) });
        }
      }
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (childKey === 'loc' || childKey === 'start' || childKey === 'end') continue;
      if (Array.isArray(child)) child.forEach((c) => visit(c, node, childKey));
      else if (child && typeof child.type === 'string') visit(child, node, childKey);
    }
  };
  visit(ast.program, null, null);
  return found;
}

// --- the menu ---------------------------------------------------------------------------------
// Every page the sidebar links to (in the pages and added by app.js) has a NAV_KEYS name, every
// group a nav.group.<name> text.
function menuGaps(en) {
  const app = fs.readFileSync(path.join(FRONTEND, 'js', 'app.js'), 'utf8');
  const navKeys = Object.fromEntries([...(app.match(/const NAV_KEYS = \{([\s\S]*?)\};/) || [])[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const gaps = [];
  const page = (href) => decodeURIComponent(href.split('?')[0].split('/').pop()).toLowerCase();
  const sidebars = fs.readdirSync(FRONTEND).filter((f) => f.endsWith('.html')).map((f) => fs.readFileSync(path.join(FRONTEND, f), 'utf8').match(/<aside class="sidebar"[\s\S]*?<\/aside>/)?.[0] || '');
  const hrefs = new Set([
    ...sidebars.flatMap((s) => [...s.matchAll(/<a[^>]*class="[^"]*nav-item[^"]*"[^>]*href="([^"]+)"|<a[^>]*href="([^"]+)"[^>]*class="[^"]*nav-item/g)].map((m) => m[1] || m[2])),
    ...[...app.matchAll(/href:\s*"([^"]+\.html)"/g)].map((m) => m[1]),
  ]);
  for (const href of hrefs) {
    const key = navKeys[page(href)];
    if (!key) gaps.push(`no NAV_KEYS name for ${href}`);
    else if (!(key in en)) gaps.push(`${key} (for ${href}) is not in en.json`);
  }
  const groups = new Set(sidebars.flatMap((s) => [...s.matchAll(/data-group="([^"]+)"/g)].map((m) => m[1])));
  for (const group of groups) if (!(`nav.group.${group}` in en)) gaps.push(`nav.group.${group} is not in en.json`);
  return gaps;
}

module.exports = { scanHtml, scanJs, menuGaps, englishWords, FRONTEND };
