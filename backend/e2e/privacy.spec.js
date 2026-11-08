const fs = require('fs');
const { test, expect } = require('@playwright/test');
const totp = require('../src/utils/totp');
const { signIn, api, page: at } = require('./helpers');

// Data trust (100 phases, phase 8, D120, docs/DATA_TRUST.md), in Hindi: an owner gives a customer
// a copy of their data and erases it from Customer 360, saves the privacy settings, finds a
// customer deleted earlier in Settings → Data & Privacy and erases them too, and sees every request
// in the register; the platform admin page runs the restore drill (a stand-in R2 in e2e/server.js).
test.describe.serial('Data trust', () => {
  let context;
  let page;
  let token;
  const owner = { email: 'owner@trust.test', name: 'Sunita Jain' };
  const admin = { email: 'admin@trust.test', name: 'Platform Admin' }; // listed in e2e/server.js
  const pageErrors = [];
  const ids = {};

  test.beforeAll(async ({ browser }) => {
    // Hindi is saved on the account before the sign-in the pages use.
    const setup = await browser.newContext();
    const first = await signIn(setup, owner);
    await api(setup, first.token, 'PATCH', '/auth/preferences', { language: 'hi' });
    await setup.close();

    context = await browser.newContext({ acceptDownloads: true });
    ({ token } = await signIn(context, owner));
    await api(context, token, 'POST', '/whatsapp/accounts', { provider: 'mock', name: 'Test number' });
    const chat = await api(context, token, 'POST', '/dev/simulate/whatsapp-inbound', { from: '98290 61001', name: 'Meena Sharma', type: 'text', text: 'Jeera 50 kg ka rate?' });
    ids.meena = chat.contactId;
    await api(context, token, 'PATCH', `/contacts/${ids.meena}`, { name: 'Meena Sharma', email: 'meena@example.in' });
    const old = await api(context, token, 'POST', '/contacts', { name: 'Purana Grahak', phone: '98290 61999' });
    await api(context, token, 'DELETE', `/contacts/${old.id}`);
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
  });
  test.afterEach(() => {
    const errors = pageErrors.splice(0);
    expect(errors, 'script errors on the page').toEqual([]);
  });
  test.afterAll(async () => {
    await context?.close();
  });

  test('Customer 360 gives the customer a copy of their data, in Hindi', async () => {
    await page.goto(at(`customer-360.html?id=${ids.meena}`));
    const panel = page.locator('#c360PrivacyPanel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('ग्राहक का डेटा');
    await page.locator('#c360DataBtn').click();
    const dialog = page.locator('#privOverlay');
    await expect(dialog).toHaveClass(/open/);
    await expect(dialog.locator('#privTitle')).toHaveText('ग्राहक का डेटा डाउनलोड करें');
    await expect(dialog.locator('#privAsked')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    const [download] = await Promise.all([page.waitForEvent('download'), dialog.locator('#privGo').click()]);
    expect(download.suggestedFilename()).toMatch(/^customer-data-\d{4}-\d{2}-\d{2}\.html$/);
    const file = fs.readFileSync(await download.path(), 'utf8');
    expect(file).toContain('Meena Sharma');
    expect(file).toContain('Jeera 50 kg ka rate?');
    expect(file).toContain('आपकी जानकारी');
    await expect(dialog).not.toHaveClass(/open/);
  });

  test('Customer 360 erases the customer\'s data once their name is typed', async () => {
    await page.locator('#c360EraseBtn').click();
    const dialog = page.locator('#privOverlay');
    await expect(dialog.locator('.priv-groups')).toBeVisible();
    await expect(dialog).toContainText('हमेशा के लिए मिटेगा');
    await expect(dialog).toContainText('बिना नाम, नंबर या जानकारी के रहेगा');
    const go = dialog.locator('#privGo');
    await expect(go).toBeDisabled();
    await dialog.locator('#privConfirm').fill('Meena');
    await expect(go).toBeDisabled();
    await dialog.locator('#privConfirm').fill('meena sharma');
    await expect(go).toBeEnabled();
    await go.click();
    await expect(dialog).not.toHaveClass(/open/);
    await expect(page.locator('#c360Erased .priv-erased')).toContainText('इस ग्राहक का डेटा मिटा दिया गया है');
    await expect(page.locator('#profileView')).toBeHidden();
    // Opened again later (an old link): it says so.
    await page.goto(at(`customer-360.html?id=${ids.meena}`));
    await expect(page.locator('#c360Erased .priv-erased')).toBeVisible();
    // Their lead stays in the list, without them; the pages that count leads still work.
    await page.goto(at('leads.html'));
    await expect(page.locator('.page')).toContainText('मिटाया गया ग्राहक');
    await expect(page.locator('.page')).not.toContainText('Meena');
    await page.goto(at('Deals.html'));
    await expect(page.locator('.page')).toContainText('मिटाया गया ग्राहक');
  });

  test('Settings keeps the privacy settings, finds a customer deleted earlier, and lists every request', async () => {
    await page.goto(at('Settings.html?tab=data'));
    const settings = page.locator('#privacySettingsSection');
    await expect(settings).toBeVisible();
    await expect(settings).toContainText('प्राइवेसी सेटिंग्स');
    await page.locator('#privContactName').fill('Sunita Jain');
    await page.locator('#privNoticeUrl').fill('meera.example/privacy');
    await page.locator('#privSave').click();
    await expect(page.locator('#privSettingsError')).toContainText('https://');
    await page.locator('#privNoticeUrl').fill('https://meera.example/privacy');
    await page.locator('#privSave').click();
    await expect(page.locator('#privSettingsError')).toBeHidden();
    await expect(page.locator('#toast-stack')).toContainText('प्राइवेसी सेटिंग्स सेव हो गईं');
    await page.reload();
    await expect(page.locator('#privContactName')).toHaveValue('Sunita Jain');
    await expect(page.locator('#privNoticeUrl')).toHaveValue('https://meera.example/privacy');

    // The register: the copy given and the erasure, without the name.
    const register = page.locator('#privRegister');
    await expect(register.locator('tbody tr')).toHaveCount(2);
    await expect(register).toContainText('डेटा मिटाया');
    await expect(register).toContainText('डेटा की कॉपी');
    await expect(register).toContainText('मिटाया गया ग्राहक');
    await expect(register).not.toContainText('Meena');

    // A customer deleted earlier is found by their number (their data is still kept), and erased.
    await page.locator('#privFindInput').fill('61999');
    await page.locator('#privFindForm button[type="submit"]').click();
    const row = page.locator('#privResults li');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Purana Grahak');
    await expect(row).toContainText('हटाया गया');
    await row.locator('[data-priv="erase"]').click();
    const dialog = page.locator('#privOverlay');
    await expect(dialog).toContainText('यह ग्राहक पहले हटाया गया था');
    await dialog.locator('#privConfirm').fill('Purana Grahak');
    await dialog.locator('#privGo').click();
    await expect(row).toHaveCount(0);
    await expect(register.locator('tbody tr')).toHaveCount(3);
  });

  test('the platform admin page runs the restore drill', async ({ browser }) => {
    const adminContext = await browser.newContext();
    const { token: adminToken } = await signIn(adminContext, admin);
    const { secret } = await api(adminContext, adminToken, 'POST', '/auth/totp/setup');
    const { backupCodes } = await api(adminContext, adminToken, 'POST', '/auth/totp/enable', { code: totp.codeAt(totp.base32Decode(secret.replace(/\s/g, '')), Date.now()) });
    await api(adminContext, adminToken, 'POST', '/dev/backup-now'); // the weekly copy, now
    const adminPage = await adminContext.newPage();
    adminPage.on('pageerror', (error) => pageErrors.push(error.message));
    await adminPage.goto(at('platform-admin.html'));
    await adminPage.locator('#paCode').fill(backupCodes[0]);
    await adminPage.locator('#paUnlockBtn').click();
    await adminPage.locator('#paTabs [data-tab="backups"]').click();
    await expect(adminPage.locator('#paBackupTable tbody tr')).toHaveCount(1);
    await expect(adminPage.locator('#paBackupWarnings')).toContainText('No restore drill');
    adminPage.once('dialog', (dialog) => dialog.accept());
    await adminPage.locator('#paDrillBtn').click();
    const latest = adminPage.locator('#paDrillTable tbody tr').first();
    await expect(latest).toContainText('Passed', { timeout: 30000 });
    await expect(latest).toContainText('admin@trust.test');
    await expect(adminPage.locator('#paBackupWarnings')).toBeHidden();
    await adminContext.close();
  });
});
