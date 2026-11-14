const fs = require('fs');
const path = require('path');
const { api } = require('./helpers/api');
const { CRM_TYPE_IDS } = require('../constants/crmTypes');

// agreem360's own website (D149), the "mother" of the product pages: it opens on agreem360.com,
// leads to every product and every CRM type, and claims nothing it cannot back.
const FRONTEND = path.resolve(__dirname, '..', '..', '..', 'crm', 'frontend');
const page = fs.readFileSync(path.join(FRONTEND, 'agreem360.html'), 'utf8');
const script = fs.readFileSync(path.join(FRONTEND, 'js', 'site.js'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'i18n', 'en.json'), 'utf8'));
const PRODUCTS = ['erp', 'marketing', 'hrm', 'scm', 'cms', 'bi', 'itsm', 'lms', 'pm', 'bpm'];

describe('agreem360 website', () => {
  it('opens on agreem360.com and www, while the CRM\'s own address keeps its home page', async () => {
    for (const host of ['agreem360.com', 'www.agreem360.com']) {
      const res = await api().get('/').set('Host', host);
      expect({ host, status: res.status, to: res.headers.location }).toEqual({ host, status: 302, to: '/crm/frontend/agreem360.html' });
    }
    for (const host of ['crm.agreem360.com', '127.0.0.1']) {
      expect((await api().get('/').set('Host', host)).headers.location).toBe('/crm/frontend/index.html');
    }
    expect((await api().get('/crm/frontend/agreem360.html')).status).toBe(200);
  });

  it('leads to every product (the CRM live, the ten coming) and to every CRM type', () => {
    expect(page).toContain('href="index.html" data-product="crm"');
    for (const id of PRODUCTS) {
      expect({ id, inMenu: page.includes(`href="index.html?product=${id}" data-product="${id}"`) }).toEqual({ id, inMenu: true });
      // Its card on the page, with its own headline, says it is coming.
      expect(page).toMatch(new RegExp(`<a class="s-product" href="index\\.html\\?product=${id}"[^>]*>[\\s\\S]*?data-i18n="lp\\.prod\\.comingSoon"[\\s\\S]*?data-i18n="lp\\.prod\\.${id}\\.h1"`));
    }
    for (const id of CRM_TYPE_IDS) {
      const href = id === 'business' ? 'index.html' : `index.html?crm=${id}`;
      expect({ id, linked: page.includes(`<a href="${href}" data-i18n="crmType.${id}">`) }).toEqual({ id, linked: true });
    }
    // Eleven nodes on the ring, the CRM marked live.
    expect((page.match(/class="s-node[ "]/g) || []).length).toBe(11);
    expect(page).toContain('<a class="s-node is-live" href="index.html"');
  });

  it('makes no claims it cannot back, and shows only the CRM\'s real screens', () => {
    const text = page.replace(/<[^>]+>/g, ' ');
    const words = Object.entries(en).filter(([key]) => key.startsWith('site.')).map(([, value]) => value).join(' ');
    for (const words_ of [text, words]) {
      expect(words_).not.toMatch(/testimonial|trusted by|loved by|customers say|\d[\d,]*\s*\+\s*(businesses|companies|customers|users|teams)/i);
      expect(words_).not.toMatch(/\b(#1|best|leading|number one)\b/i);
    }
    const images = [...page.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    for (const src of images) {
      expect(src).toMatch(/^img\/(landing|icons)\//);
      expect(fs.existsSync(path.join(FRONTEND, src))).toBe(true);
    }
    expect(page).not.toMatch(/js\/app\.js|font-awesome|css\/style\.css/);
    // The trial's length comes from the plans (D147), with 45 only until they answer.
    expect(script).toContain('/site/plans');
    expect(script).toContain('.js-trial-days');
  });

  it('shares like the other public pages, and links the legal pages', () => {
    expect(page).toContain('<link rel="canonical" href="https://crm.agreem360.com/crm/frontend/agreem360.html" />');
    expect(page).toContain('<meta property="og:image" content="https://crm.agreem360.com/crm/frontend/img/icons/icon-512.png" />');
    expect(page).toMatch(/<meta name="description" content="[^"]{50,160}"/);
    for (const link of ['privacy.html', 'terms.html', 'refund.html', 'delivery.html', 'contact.html', 'login.html', 'login.html?signup=1']) {
      expect(page).toContain(`href="${link}"`);
    }
  });
});
