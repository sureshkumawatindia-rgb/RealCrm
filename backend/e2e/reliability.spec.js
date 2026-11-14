const { test, expect } = require('@playwright/test');
const totp = require('../src/utils/totp');
const { signIn, api, page: at } = require('./helpers');

// Reliability (100 phases, phase 9, D151, docs/RELIABILITY.md): the public status page, a reply
// that waits while Meta is in trouble and the company's "Failed sends" list with "Try again", and a
// platform notice that becomes a banner inside the CRM and a line on the status page until it ends.
test.describe.serial('Reliability', () => {
  let context;
  let page;
  let token;
  let chatId;
  const owner = { email: 'owner@status.test', name: 'Farhan Ali' };
  const admin = { email: 'admin@status.test', name: 'Platform Admin' }; // listed in e2e/server.js
  const customer = { phone: '919829055501', name: 'Lakshmi Traders' };
  const pageErrors = [];

  test.beforeAll(async ({ browser }, testInfo) => {
    // A retry (on GitHub) starts in a company of its own, with an admin whose authenticator is not on yet.
    if (testInfo.retry || testInfo.repeatEachIndex) {
      owner.email = `owner-${testInfo.repeatEachIndex}-${testInfo.retry}@status.test`;
      admin.email = 'admin-again@status.test';
    }
    context = await browser.newContext();
    ({ token } = await signIn(context, owner));
    await api(context, token, 'POST', '/whatsapp/accounts', { provider: 'mock', name: 'Test number' });
    ({ conversationId: chatId } = await api(context, token, 'POST', '/dev/simulate/whatsapp-inbound', { from: customer.phone, name: customer.name, type: 'text', text: 'Rate list bhejiye' }));
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
  });
  test.afterEach(() => {
    const errors = pageErrors.splice(0);
    expect(errors, 'script errors on the page').toEqual([]);
  });
  test.afterAll(async () => {
    await context?.request.post('/api/v1/dev/simulate/service-trouble', { headers: { Authorization: `Bearer ${token}` }, data: { on: false } }).catch(() => {});
    await context?.close();
  });

  // Each look at the public page in a context of its own: GET /status may be kept for 30 seconds.
  async function statusPage(browser) {
    const visitor = await browser.newContext();
    const view = await visitor.newPage();
    view.on('pageerror', (error) => pageErrors.push(error.message));
    await view.goto(at('status.html'));
    return { visitor, view };
  }

  test('the status page answers without a sign-in, in English and Hindi', async ({ browser }) => {
    const { visitor, view } = await statusPage(browser);
    await expect(view.locator('#statusHero')).toContainText('Everything is working');
    await expect(view.locator('#statusServices .status-service')).toHaveCount(5);
    await expect(view.locator('#statusServices')).toContainText('WhatsApp (Meta)');
    await view.locator('[data-status-language="hi"]').click();
    await expect(view.locator('#statusHero')).toContainText('सब कुछ ठीक चल रहा है');
    await expect(view.locator('#statusServices')).toContainText('WhatsApp (मेटा)');
    await visitor.close();

    // The sign-in page leads to it.
    const guest = await browser.newContext();
    const login = await guest.newPage();
    await login.goto(at('login.html'));
    await expect(login.locator('a[href="status.html"]')).toBeVisible();
    await guest.close();
  });

  test('a reply while Meta is in trouble waits; "Don\'t send" stops it, and Failed sends sends it once Meta is back', async () => {
    await api(context, token, 'POST', '/dev/simulate/service-trouble', { on: true });
    const sent = await api(context, token, 'POST', `/conversations/${chatId}/messages`, { type: 'text', text: 'Rate list 2026 attached ji' });
    expect(sent.status).toBe('queued');
    expect(sent.retry?.nextAt).toBeTruthy();

    await page.goto(at(`Inbox.html?c=${chatId}`));
    const waiting = page.locator('.msg-wait');
    await expect(waiting).toContainText('It will try again by itself');
    await waiting.locator('[data-retry-stop]').click();
    await expect(page.locator('[data-retry-send]')).toBeVisible();
    await expect(page.locator('.msg-wait')).toHaveCount(0);

    await page.goto(at('Settings.html'));
    await page.locator('#deliveryTab').click();
    const item = page.locator('#deliveryList .deliv-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(customer.name);
    await expect(item).toContainText('Rate list 2026 attached ji');
    await expect(page.locator('#deliveryCount')).toHaveText('1');

    await api(context, token, 'POST', '/dev/simulate/service-trouble', { on: false });
    await item.locator('[data-deliv-retry]').click();
    await expect(page.locator('#deliveryList .deliv-empty')).toContainText('Everything went');
    const { items } = await api(context, token, 'GET', `/conversations/${chatId}/messages`).then((data) => ({ items: data.items || data }));
    const reply = items.find((m) => m.text === 'Rate list 2026 attached ji');
    expect(reply.status).not.toBe('failed');
    expect(reply.status).not.toBe('queued');
  });

  test('a platform notice about WhatsApp is a banner for companies with WhatsApp and a line on the status page, until it ends', async ({ browser }) => {
    const adminContext = await browser.newContext();
    const adminSession = await signIn(adminContext, admin);
    const { secret } = await api(adminContext, adminSession.token, 'POST', '/auth/totp/setup');
    const { backupCodes } = await api(adminContext, adminSession.token, 'POST', '/auth/totp/enable', { code: totp.codeAt(totp.base32Decode(secret.replace(/\s/g, '')), Date.now()) });
    const adminPage = await adminContext.newPage();
    adminPage.on('pageerror', (error) => pageErrors.push(error.message));
    await adminPage.goto(at('platform-admin.html'));
    await adminPage.locator('#paCode').fill(backupCodes[0]);
    await adminPage.locator('#paUnlockBtn').click();
    await adminPage.locator('#paTabs [data-tab="health"]').click();
    await expect(adminPage.locator('#paHealthOpen')).toBeVisible();
    await adminPage.locator('#paNoticeService').selectOption('whatsapp');
    await adminPage.locator('#paNoticeLevel').selectOption('degraded');
    await adminPage.locator('#paNoticeTitleEn').fill('Meta is slow today');
    await adminPage.locator('#paNoticeTitleHi').fill('आज मेटा धीमा है');
    await adminPage.locator('#paNoticePost').click();
    await expect(adminPage.locator('#paHealthOpen')).toContainText('Meta is slow today');

    await page.goto(at('dashboard.html'));
    const banner = page.locator('.status-banner');
    await expect(banner).toHaveCount(1);
    await expect(banner).toContainText('Meta is slow today');
    await expect(banner.locator('a[href="status.html"]')).toBeVisible();
    await banner.locator('.plan-banner-close').click();
    await expect(page.locator('.status-banner')).toHaveCount(0);

    let look = await statusPage(browser);
    await expect(look.view.locator('#statusHero')).toContainText('Some things are having trouble');
    await expect(look.view.locator('#statusNotices')).toContainText('Meta is slow today');
    await look.visitor.close();

    await adminPage.locator('#paHealthOpen [data-pa-end]').first().click();
    await expect(adminPage.locator('#paHealthOpen [data-pa-end]')).toHaveCount(0);
    await expect(adminPage.locator('#paHealthRecent')).toContainText('Meta is slow today');
    await adminContext.close();

    look = await statusPage(browser);
    await expect(look.view.locator('#statusHero')).toContainText('Everything is working');
    await expect(look.view.locator('#statusNotices')).not.toContainText('Meta is slow today');
    await look.visitor.close();
  });
});
