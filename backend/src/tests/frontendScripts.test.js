const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Classic <script> tags share one global scope: a const/let declared in app.js and again in a
// page script is a SyntaxError that silently breaks the whole page script. This compiles each
// page's scripts together, in page order, to catch that (and plain syntax errors).
const FRONTEND = path.resolve(__dirname, '..', '..', '..', 'crm', 'frontend');
const pages = fs.readdirSync(FRONTEND).filter((file) => file.endsWith('.html'));

function scriptsOf(page) {
  const html = fs.readFileSync(path.join(FRONTEND, page), 'utf8');
  const scripts = [];
  for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    const src = /src="([^"]+)"/.exec(match[1])?.[1];
    if (!src) scripts.push({ name: `${page} (inline)`, code: match[2] });
    else if (!/^https?:/.test(src)) scripts.push({ name: src, code: fs.readFileSync(path.resolve(FRONTEND, src), 'utf8') });
  }
  return scripts;
}

describe('Frontend pages', () => {
  it.each(pages)('%s: scripts compile together without clashing declarations', (page) => {
    const scripts = scriptsOf(page);
    const combined = scripts.map((script) => `// ---- ${script.name}\n${script.code}\n;`).join('\n');
    expect(() => new vm.Script(combined, { filename: page })).not.toThrow();
  });
});

// Customers' own text (WhatsApp names, captions, messages) reaches the pages, often inside HTML
// attributes: every escapeHtml must escape quotes as well as <, > and &.
const scriptFiles = fs.readdirSync(path.join(FRONTEND, 'js')).filter((file) => file.endsWith('.js'));
describe('escapeHtml', () => {
  it.each(scriptFiles)('js/%s escapes quotes wherever it defines escapeHtml', (file) => {
    const code = fs.readFileSync(path.join(FRONTEND, 'js', file), 'utf8');
    const match = /function escapeHtml\(str\) \{[\s\S]*?\n\}/.exec(code);
    if (!match) return;
    const sandbox = {
      document: { createElement: () => ({ set textContent(v) { this.html = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }, get innerHTML() { return this.html; } }) },
    };
    const escapeHtml = new vm.Script(`(${match[0]})`).runInNewContext(sandbox);
    expect(escapeHtml('x" onerror="alert(1)\' <b>&')).toBe('x&quot; onerror=&quot;alert(1)&#39; &lt;b&gt;&amp;');
  });
});
