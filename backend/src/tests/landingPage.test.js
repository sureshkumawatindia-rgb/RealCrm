jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const fs = require('fs');
const path = require('path');
const { PLANS } = require('../constants/plans');
const { api, bearer, login } = require('./helpers/api');

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
    expect(res.body.data).toMatchObject({ gstPct: 18, trialDays: 30, trialPlan: 'growth' });
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
    for (const link of ['privacy.html', 'terms.html', 'privacy.html#data-deletion', 'login.html', 'login.html?signup=1']) {
      expect(page).toContain(`href="${link}"`);
    }
    const login = fs.readFileSync(path.join(FRONTEND, 'login.html'), 'utf8');
    expect(page).toContain('<meta property="og:image" content="img/icons/icon-512.png" />');
    expect(login).toContain('<meta property="og:image" content="img/icons/icon-512.png" />');
    expect(page).toMatch(/<meta name="description" content="[^"]{50,160}"/);
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
