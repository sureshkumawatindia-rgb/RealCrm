const fs = require('fs');
const path = require('path');

// The pages' texts (crm/frontend/i18n, English and Hindi) for what the server writes for people:
// a customer's data file (Phase 8, D120). One place for every Hindi text, checked by i18n.test.js.
const DIR = path.resolve(__dirname, '..', '..', '..', 'crm', 'frontend', 'i18n');
const cache = new Map(); // language → { mtimeMs, texts }

function load(language) {
  const file = path.join(DIR, `${language}.json`);
  try {
    const { mtimeMs } = fs.statSync(file);
    const kept = cache.get(language);
    if (kept && kept.mtimeMs === mtimeMs) return kept.texts;
    const texts = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache.set(language, { mtimeMs, texts });
    return texts;
  } catch {
    return cache.get(language)?.texts || {};
  }
}

// t(key, { name: … }) in the language (English when a text is missing), as the pages' t() does.
function textsFor(language) {
  const lang = language === 'hi' ? 'hi' : 'en';
  const own = load(lang);
  const english = lang === 'en' ? own : load('en');
  const t = (key, params = {}) => String(own[key] ?? english[key] ?? key)
    .replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  t.has = (key) => key in own || key in english;
  t.language = lang;
  // A value's label from a group ("stage.Won"), or the value itself.
  t.label = (group, value) => (value && t.has(`${group}.${value}`) ? t(`${group}.${value}`) : String(value || ''));
  return t;
}

module.exports = { textsFor };
