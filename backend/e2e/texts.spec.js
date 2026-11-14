const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { signIn, api, page: at } = require('./helpers');

// The pages in Hindi when their texts come late (Phase 4, D116, docs/HINDI_GUIDE.md). t() knows a
// text only once i18n/hi.json is in, so a page that draws before that shows the key ("setls.none")
// instead of the words. Here the texts are held back 1.5 seconds: no page may show a key, in its
// words or in its tooltips, placeholders and labels.
const KEYS = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'crm', 'frontend', 'i18n', 'en.json'), 'utf8'))));
const SETTINGS_TABS = ['profile', 'company', 'team', 'whatsapp', 'leadsources', 'leadrules', 'pipelines', 'fields', 'connections', 'calling', 'sms',
  'payments', 'ai', 'integrations', 'approvals', 'delivery', 'audit', 'billing', 'plan', 'data'];
const PAGES = [
  'invite-team.html', 'company.html', 'dashboard.html', 'Inbox.html', 'customers.html', 'leads.html', 'Deals.html', 'Quotations.html', 'Orders.html',
  'Products.html', 'Tasks.html', 'projects.html', 'Support.html', 'Reports & Analytics.html', 'my-performance.html', 'team-live.html',
  'accounts.html', 'workflow-builder.html', 'Al Insights.html', 'platform-admin.html', 'help.html',
  ...SETTINGS_TABS.map((tab) => `Settings.html?tab=${tab}`),
];

test.describe.serial('Pages in Hindi when the texts come late (D116)', () => {
  let context;
  let page;
  const owner = { email: 'owner@texts.test', name: 'Meena Gupta' };
  const pageErrors = [];

  test.beforeAll(async ({ browser }) => {
    // Hindi is saved on the account before the sign-in the pages use, so they start in Hindi.
    const setup = await browser.newContext();
    const { token } = await signIn(setup, owner);
    await api(setup, token, 'PATCH', '/auth/preferences', { language: 'hi' });
    await setup.close();
    // No service worker: every text file goes through the route below.
    context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/i18n/*.json', async (route) => {
      await new Promise((resolve) => { setTimeout(resolve, 1500); });
      await route.continue();
    });
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await signIn(context, owner);
  });
  test.afterEach(() => {
    const errors = pageErrors.splice(0);
    expect(errors, 'script errors on the page').toEqual([]);
  });
  test.afterAll(async () => {
    await context?.close();
  });

  for (const name of PAGES) {
    test(name, async () => {
      await page.goto(at(name));
      await page.waitForFunction(() => document.documentElement.lang === 'hi' && !document.documentElement.classList.contains('i18n-pending'), null, { timeout: 15000 });
      // The page's own answers from the server come after the texts; give them a moment to draw.
      await page.waitForTimeout(1200);
      const words = await page.evaluate(() => {
        const texts = [document.body.innerText];
        document.querySelectorAll('[title], [placeholder], [aria-label], [alt]').forEach((el) => {
          ['title', 'placeholder', 'aria-label', 'alt'].forEach((name) => { if (el.hasAttribute(name)) texts.push(el.getAttribute(name)); });
        });
        return texts.join('\n').match(/[a-z][\w-]*(?:\.[\w-]+)+/g) || [];
      });
      expect(words.filter((word) => KEYS.has(word)), `keys shown on ${name}`).toEqual([]);
    });
  }
});
