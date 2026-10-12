const fs = require('fs');
const path = require('path');

// CP5: the pages' texts in English and Hindi (crm/frontend/i18n). Every key a page uses exists,
// both languages have the same keys and the same {placeholders}, and Hindi is written in
// Devanagari (names such as WhatsApp and GST may stay in English inside it).
const FRONTEND = path.resolve(__dirname, '..', '..', '..', 'crm', 'frontend');
const en = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'i18n', 'en.json'), 'utf8'));
const hi = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'i18n', 'hi.json'), 'utf8'));
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const pages = fs.readdirSync(FRONTEND).filter((file) => file.endsWith('.html'));
const scripts = fs.readdirSync(path.join(FRONTEND, 'js')).filter((file) => file.endsWith('.js'));

describe('Texts in English and Hindi', () => {
  it('has the same keys in both languages, nothing empty, the same placeholders', () => {
    expect(Object.keys(hi).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect({ key, en: Boolean(String(en[key]).trim()), hi: Boolean(String(hi[key]).trim()) }).toEqual({ key, en: true, hi: true });
      expect({ key, placeholders: placeholders(hi[key]) }).toEqual({ key, placeholders: placeholders(en[key]) });
    }
  });

  it('writes Hindi in Devanagari', () => {
    const notHindi = Object.entries(hi).filter(([, text]) => !/[ऀ-ॿ]/.test(text)).map(([key]) => key);
    expect(notHindi).toEqual([]);
  });

  it.each(pages)('%s uses only keys that exist', (page) => {
    const html = fs.readFileSync(path.join(FRONTEND, page), 'utf8');
    const keys = [...html.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria-label)?="([^"]+)"/g)].map((m) => m[1]);
    expect(keys.filter((key) => !(key in en))).toEqual([]);
  });

  it.each(scripts)('js/%s uses only keys that exist', (file) => {
    const code = fs.readFileSync(path.join(FRONTEND, 'js', file), 'utf8');
    const keys = [
      ...[...code.matchAll(/(?<![\w.$])t\(\s*"([\w.]+)"/g)].map((m) => m[1]),
      ...[...code.matchAll(/(?<![\w.$])lt\(\s*"([\w.]+)"/g)].map((m) => `login.${m[1]}`), // login.js
    ];
    expect(keys.filter((key) => !(key in en))).toEqual([]);
  });
});
