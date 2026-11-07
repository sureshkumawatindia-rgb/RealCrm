const { test, expect } = require('@playwright/test');
const totp = require('../src/utils/totp');
const { signIn, api, page: at } = require('./helpers');

// Help inside the CRM (100 phases, phase 6, D118, docs/HELP.md): a page's "?" box, the help centre
// and its search, and the platform's support number — set on the platform admin page behind its
// authenticator code — becoming a WhatsApp button in every company's help.
test.describe.serial('Help inside the CRM', () => {
  let context;
  let page;
  const member = { email: 'trader@help.test', name: 'Kiran Shah' };
  const admin = { email: 'admin@help.test', name: 'Platform Admin' }; // listed in e2e/server.js
  const pageErrors = [];

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await signIn(context, member);
  });
  test.afterEach(() => {
    const errors = pageErrors.splice(0);
    expect(errors, 'script errors on the page').toEqual([]);
  });
  test.afterAll(async () => {
    await context?.close();
  });

  test('a page\'s ? opens its short help, and from there its topic in the help centre', async () => {
    await page.goto(at('leads.html'));
    await page.locator('#crmHelpBtn').click();
    const box = page.locator('#helpOverlay');
    await expect(box).toHaveClass(/open/);
    await expect(box.locator('#helpTitle')).toContainText('Leads');
    await expect(box.locator('.help-points li')).toHaveCount(4);
    await expect(box.locator('.btn-whatsapp')).toHaveCount(0); // no support number yet
    await page.keyboard.press('Escape');
    await expect(box).not.toHaveClass(/open/);
    await expect(page.locator('#crmHelpBtn')).toBeFocused();

    await page.locator('#crmHelpBtn').click();
    await box.locator('a[href="help.html#topic-leads"]').click();
    await expect(page).toHaveURL(/help\.html#topic-leads$/);
    await expect(page.locator('#topic-leads')).toHaveAttribute('open', '');
  });

  test('the help centre finds a question by its words', async () => {
    await page.goto(at('help.html'));
    await expect(page.locator('#helpFaq .help-item')).toHaveCount(11); // Phase 7 (D119): working without internet
    await expect(page.locator('#helpTopics .help-item')).toHaveCount(25);
    await page.locator('#helpSearch').fill('quotation whatsapp');
    await expect(page.locator('#faq-quotation')).toBeVisible();
    await expect(page.locator('#faq-hindi')).toBeHidden();
    await page.locator('#helpSearch').fill('without internet');
    await expect(page.locator('#faq-offline')).toBeVisible();
    await expect(page.locator('#faq-quotation')).toBeHidden();
    await page.locator('#helpSearch').fill('zzzz');
    await expect(page.locator('#helpNoMatch')).toBeVisible();
    // The menu has Help, and the help centre has no "?" of its own.
    await expect(page.locator('.sidebar .nav-item[href="help.html"]')).toHaveClass(/active/);
    await expect(page.locator('#crmHelpBtn')).toHaveCount(0);
  });

  test('the platform\'s support number becomes a WhatsApp button in every company\'s help', async ({ browser }) => {
    const adminContext = await browser.newContext();
    const { token } = await signIn(adminContext, admin);
    const { secret } = await api(adminContext, token, 'POST', '/auth/totp/setup');
    const { backupCodes } = await api(adminContext, token, 'POST', '/auth/totp/enable', { code: totp.codeAt(totp.base32Decode(secret.replace(/\s/g, '')), Date.now()) });
    const adminPage = await adminContext.newPage();
    await adminPage.goto(at('platform-admin.html'));
    await adminPage.locator('#paCode').fill(backupCodes[0]);
    await adminPage.locator('#paUnlockBtn').click();
    await adminPage.locator('#paTabs [data-tab="support"]').click();
    await adminPage.locator('#paSupportWhatsapp').fill('98290 12345');
    await adminPage.locator('#paSupportHours').fill('Mon–Sat, 10 am – 7 pm');
    await adminPage.locator('#paSupportSave').click();
    await expect(adminPage.locator('#paSupportWhatsapp')).toHaveValue('+919829012345');
    await adminContext.close();

    await page.goto(at('Quotations.html'));
    await page.locator('#crmHelpBtn').click();
    const button = page.locator('#helpOverlay .btn-whatsapp');
    await expect(button).toBeVisible();
    const href = await button.getAttribute('href');
    expect(href).toMatch(/^https:\/\/wa\.me\/919829012345\?text=/);
    expect(decodeURIComponent(href.split('text=')[1])).toContain('Quotations');
    await expect(page.locator('#helpOverlay .help-contact')).toContainText('Mon–Sat, 10 am – 7 pm');
  });
});
