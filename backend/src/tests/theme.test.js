const fs = require('fs');
const path = require('path');

// CP5: the light and dark themes (crm/frontend/css/style.css). Text stays readable (WCAG AA,
// 4.5:1) on every background it is used on, and the dark values are the same whether the
// device asks for dark ("System") or the person chose "Dark".
const css = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'crm', 'frontend', 'css', 'style.css'), 'utf8').replace(/\r\n/g, '\n');

function block(start) {
  const from = css.indexOf(start);
  if (from < 0) throw new Error(`no ${start}`);
  let depth = 0;
  for (let i = css.indexOf('{', from); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) return css.slice(css.indexOf('{', from) + 1, i);
  }
  throw new Error(`unclosed ${start}`);
}
const tokens = (text) => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

const light = tokens(block(':root {'));
const darkChosen = tokens(block(':root[data-theme="dark"] {'));
const darkSystem = tokens(block(':root:not([data-theme="light"]) {'));
const dark = { ...light, ...darkChosen };

function rgb(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (!hex) throw new Error(`not a plain colour: ${value}`);
  return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
}
function luminance(value) {
  const [r, g, b] = rgb(value).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [text, background]: the pairs the pages use.
const PAIRS = [
  ['text', 'bg'], ['text', 'surface'], ['text', 'panel-2'],
  ['text-muted', 'bg'], ['text-muted', 'surface'],
  ['danger-text', 'surface'], ['success-text', 'surface'], ['warning-text', 'surface'],
  ['text', 'bubble-in'], ['text', 'bubble-out'],
  ['on-brand', 'brand'], ['on-brand', 'brand-dark'], ['on-ink', 'ink-fill'],
];

describe('Themes', () => {
  it('uses the same dark values for "System" on a dark device and for "Dark" chosen', () => {
    expect(darkSystem).toEqual(darkChosen);
  });

  it.each([['light', light], ['dark', dark]])('keeps text readable in the %s theme', (name, theme) => {
    const low = PAIRS.map(([text, background]) => ({ text, background, ratio: Math.round(contrast(theme[text], theme[background]) * 10) / 10 }))
      .filter((pair) => pair.ratio < 4.5);
    expect(low).toEqual([]);
  });

  it('keeps yellow links readable on the dark background', () => {
    expect(contrast(dark['brand-darker'], dark.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark['brand-darker'], dark.bg)).toBeGreaterThanOrEqual(4.5);
  });
});
