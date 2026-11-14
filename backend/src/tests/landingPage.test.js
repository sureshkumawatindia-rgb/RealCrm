jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const fs = require('fs');
const path = require('path');
const { PLANS } = require('../constants/plans');
const { api, bearer, login } = require('./helpers/api');
const PlatformSetting = require('../models/PlatformSetting');
const env = require('../config/env');
const { CRM_TYPE_IDS } = require('../constants/crmTypes');
const { KITS } = require('../constants/businessKits');

// The public home page (CP4): plans from one place, nothing made up, and the links Meta's App
// Review and visitors need.
const FRONTEND = path.resolve(__dirname, '..', '..', '..', 'crm', 'frontend');
const page = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(FRONTEND, 'js', 'landing.js'), 'utf8');

describe('Home page', () => {
  it('reads the plans without signing in: the same list owners see, cacheable, nothing about a company', async () => {
    const res = await api().get('/api/v1/site/plans');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body.data.plans.map((p) => p.key)).toEqual(['starter', 'pro', 'growth', 'scale', 'infinite']);
    expect(res.body.data).toMatchObject({ gstPct: 18, trialDays: 45, trialPlan: 'growth' });
    expect(res.body.data.included.length).toBeGreaterThan(0);

    const owner = await login('landing-owner@example.com');
    const signedIn = await api().get('/api/v1/billing/plans').set(bearer(owner.token));
    expect(res.body.data).toEqual(signedIn.body.data);
    expect(JSON.stringify(res.body.data)).not.toMatch(/organization|aiBudgetShare|landing-owner/i);
  });

  it('writes no price into the page: every amount comes from constants/plans.js', () => {
    for (const plan of Object.values(PLANS)) {
      const rupees = (plan.pricePaise / 100).toLocaleString('en-IN');
      expect(page).not.toContain(`₹${rupees}`);
      expect(script).not.toContain(rupees);
    }
    expect(script).toContain('/site/plans');
  });

  it('makes no claims it cannot back: no testimonials, customer logos or "10,000+ businesses"', () => {
    const text = page.replace(/<[^>]+>/g, ' ');
    expect(text).not.toMatch(/testimonial|trusted by|loved by|customers say|\d[\d,]*\s*\+\s*(businesses|companies|customers|users|teams)/i);
    expect(text).not.toMatch(/\b(#1|best|leading)\b/i);
  });

  it('sends a signed-in browser to the dashboard, links the legal pages, and shares like the login page', () => {
    expect(page).toMatch(/localStorage\.getItem\("crm_session"\)[\s\S]*?window\.location\.replace\("dashboard\.html"\)/);
    for (const link of ['privacy.html', 'terms.html', 'privacy.html#data-deletion', 'refund.html', 'delivery.html', 'contact.html', 'login.html', 'login.html?signup=1']) {
      expect(page).toContain(`href="${link}"`);
    }
    const login = fs.readFileSync(path.join(FRONTEND, 'login.html'), 'utf8');
    // A shared link's card needs full addresses (D141): the CRM's own domain, and a picture that exists.
    expect(page).toContain('<meta property="og:image" content="https://crm.agreem360.com/crm/frontend/img/icons/icon-512.png" />');
    expect(login).toContain('<meta property="og:image" content="https://crm.agreem360.com/crm/frontend/img/icons/icon-512.png" />');
    expect(page).toContain('<link rel="canonical" href="https://crm.agreem360.com/crm/frontend/index.html" />');
    expect(fs.existsSync(path.join(FRONTEND, 'img', 'icons', 'icon-512.png'))).toBe(true);
    expect(page).toMatch(/<meta name="description" content="[^"]{50,160}"/);
  });

  it('tells the legal and contact pages who runs the CRM and how to reach support, without signing in', async () => {
    const before = await api().get('/api/v1/site');
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({ name: expect.any(String), gstin: expect.any(String), support: { whatsapp: '', email: '', hours: '' } });

    await PlatformSetting.updateOne({ key: 'support' }, { $set: { value: { whatsapp: '+919829012345', email: 'help@agreem.example', hours: 'Mon–Sat, 10 am – 7 pm' } } }, { upsert: true });
    const after = await api().get('/api/v1/site');
    expect(after.body.data.support).toEqual({ whatsapp: '+919829012345', email: 'help@agreem.example', hours: 'Mon–Sat, 10 am – 7 pm' });
    expect(JSON.stringify(after.body.data)).not.toMatch(/organization|secret|key/i);
  });

  it('has the policy pages a payment gateway checks, public and linked from each other', () => {
    const PUBLIC = /const PUBLIC_PAGES = new Set\(\[([^\]]*)\]\)/.exec(fs.readFileSync(path.join(FRONTEND, 'js', 'app.js'), 'utf8'))[1];
    for (const name of ['privacy.html', 'terms.html', 'refund.html', 'delivery.html', 'contact.html']) {
      const html = fs.readFileSync(path.join(FRONTEND, name), 'utf8');
      expect(PUBLIC).toContain(`"${name}"`);
      expect(html).toContain('<script src="js/legal.js"></script>');
      for (const other of ['terms.html', 'privacy.html', 'refund.html', 'delivery.html', 'contact.html']) expect(html).toContain(`href="${other}"`);
    }
  });

  it('tells search engines the public pages only, at the address in PUBLIC_URL (D141)', async () => {
    const robots = await api().get('/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.headers['content-type']).toMatch(/^text\/plain/);
    expect(robots.text).toContain('Disallow: /crm/frontend/');
    expect(robots.text).toContain('Disallow: /api/');
    expect(robots.text).toContain(`Sitemap: ${env.publicUrl}/sitemap.xml`);
    expect(robots.text).not.toContain('Allow: /crm/frontend/dashboard.html');

    const sitemap = await api().get('/sitemap.xml').buffer(true);
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers['content-type']).toMatch(/^application\/xml/);
    const xml = sitemap.text;
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset /);
    for (const name of ['agreem360.html', 'index.html', 'privacy.html', 'terms.html', 'refund.html', 'delivery.html', 'contact.html']) {
      expect(xml).toContain(`<loc>${env.publicUrl}/crm/frontend/${name}</loc>`);
      expect(robots.text).toContain(`Allow: /crm/frontend/${name}`); // each page in the sitemap may be read
      expect(fs.existsSync(path.join(FRONTEND, name))).toBe(true);
    }
  });

  // D146: agreem360's products; the CRM's business types each have their own home page.
  it('lists every CRM type after "CRM" and the coming products under Products, each with its texts', () => {
    const en = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'i18n', 'en.json'), 'utf8'));
    const types = [...page.matchAll(/<a href="index\.html(?:\?crm=(\w+))?" data-crm="(\w+)"/g)];
    expect(types.map((m) => m[2])).toEqual(CRM_TYPE_IDS);
    for (const [, inLink, id] of types) {
      expect(inLink || 'business').toBe(id); // "business" is the plain page
      if (id !== 'business') expect([en[`lp.crm.${id}.h1`], en[`lp.crm.${id}.lead`]]).toEqual([expect.any(String), expect.any(String)]);
    }
    // D148: CRM, then the ten coming products. The bar shows CRM, ERP, Marketing Automation, HRM / HRIS
    // and one more (SCM until another is chosen from Other); each has six parts and ten kinds of business.
    const products = [...page.matchAll(/data-product="(\w+)"/g)].map((m) => m[1]);
    expect(products).toEqual(['crm', 'erp', 'marketing', 'hrm', 'scm', 'cms', 'bi', 'itsm', 'lms', 'pm', 'bpm']);
    expect(script).toContain('const FIXED = ["crm", "erp", "marketing", "hrm"];');
    expect(script).toContain('let fifth = "scm";');
    const listed = /const FIELDS = \{([\s\S]*?)\n\s*\};/.exec(script)[1];
    const fields = Object.fromEntries([...listed.matchAll(/(\w+): \[([^\]]*)\]/g)].map((m) => [m[1], [...m[2].matchAll(/"(\w+)"/g)].map((f) => f[1])]));
    expect(Object.keys(fields)).toEqual(products.slice(1));
    for (const id of products.slice(1)) {
      expect(new Set(fields[id]).size).toBe(10);
      const parts = ['full', 'h1', 'about', 'p1', 'p2', 'p3', 'p4'];
      for (let n = 1; n <= 6; n += 1) parts.push(...['title', 'text', 't1', 't2', 't3'].map((part) => `f${n}.${part}`));
      for (const field of fields[id]) parts.push(...['name', 'h1', 'lead'].map((part) => `field.${field}.${part}`));
      for (const part of parts) expect({ id, part, text: typeof en[`lp.prod.${id}.${part}`] }).toEqual({ id, part, text: 'string' });
    }
    // A product that is not built yet says so, and offers the CRM meanwhile.
    expect((page.match(/class="lp-soon" data-i18n="lp\.soon"/g) || []).length).toBe(10);
    expect(page).toContain('<span translate="no">agreem360</span>');
    expect(page).toContain('© <span id="year"></span> <span translate="no">agreem360</span>');
  });

  it('tells each CRM type\'s page what choosing the type adds, from the same set-ups, without signing in', async () => {
    const res = await api().get('/api/v1/site/crm-types');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const types = res.body.data;
    expect(types.map((type) => type.id)).toEqual(CRM_TYPE_IDS.filter((id) => id !== 'business'));
    const pest = types.find((type) => type.id === 'pest_control');
    expect(pest.stages.map((stage) => stage.en)).toEqual(KITS.pest_control.stages.map((stage) => stage.name.en));
    expect(pest.products).toContainEqual({ en: 'Termite treatment', hi: 'दीमक ट्रीटमेंट' });
    expect(pest.records).toEqual([{ en: 'AMC contracts', hi: 'AMC कॉन्ट्रैक्ट' }]);
    expect(pest.templates).toEqual([{ en: 'AMC: 4 visits a year', hi: 'AMC: साल में 4 विज़िट' }]);
    for (const type of types) {
      expect(type.stages.length).toBeGreaterThan(0);
      for (const words of [type.about, ...type.stages, ...type.products, ...type.fields, ...type.records, ...type.templates, ...type.quickReplies]) {
        expect(words).toEqual({ en: expect.stringMatching(/\S/), hi: expect.stringMatching(/\S/) }); // in both languages ("BHK" stays "BHK")
      }
    }
    // Names only: no prices, quick reply texts or anything of a company.
    for (const type of types) expect(Object.keys(type).sort()).toEqual(['about', 'fields', 'id', 'products', 'quickReplies', 'records', 'stages', 'templates']);
    expect(JSON.stringify(types)).not.toMatch(/organization|Paise|\{\{/);
  });

  it('stays light: only real screenshots that exist, small, with size and alt text; no app.js or icon font', () => {
    const images = [...page.matchAll(/<img\b[^>]*>/g)].map((match) => match[0]);
    const shots = images.filter((tag) => tag.includes('img/landing/'));
    expect(shots.length).toBeGreaterThanOrEqual(5);
    for (const tag of shots) {
      const src = /src="([^"]+)"/.exec(tag)[1];
      const file = path.join(FRONTEND, src);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).size).toBeLessThan(150 * 1024);
      expect(tag).toMatch(/width="\d+"\s+height="\d+"/);
      expect(/alt="([^"]*)"/.exec(tag)[1].length).toBeGreaterThan(10);
    }
    expect(page).not.toMatch(/js\/app\.js|font-awesome|css\/style\.css/);
  });
});
