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
