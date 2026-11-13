jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const fs = require('fs');
const path = require('path');
const { PLANS } = require('../constants/plans');
const { api, bearer, login } = require('./helpers/api');
const PlatformSetting = require('../models/PlatformSetting');
const env = require('../config/env');

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
    expect(res.body.data).toMatchObject({ gstPct: 18, trialDays: 3, trialPlan: 'growth' });
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
    for (const name of ['index.html', 'privacy.html', 'terms.html', 'refund.html', 'delivery.html', 'contact.html']) {
      expect(xml).toContain(`<loc>${env.publicUrl}/crm/frontend/${name}</loc>`);
      expect(robots.text).toContain(`Allow: /crm/frontend/${name}`); // each page in the sitemap may be read
      expect(fs.existsSync(path.join(FRONTEND, name))).toBe(true);
    }
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
