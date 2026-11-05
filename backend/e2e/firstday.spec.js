const { test, expect } = require('@playwright/test');
const { signIn, api, page: at } = require('./helpers');

// The first day (100 phases, phase 5, D117, docs/FIRST_DAY.md): a new owner's "Get your CRM ready"
// list on the dashboard ticks itself, ready settings go in with one click (in the owner's
// language), the leads step opens the import box, and the list hides for this person and comes
// back from Settings → Your Profile.
test.describe.serial('The first day', () => {
  let context;
  let page;
  let token;
  const owner = { email: 'owner@firstday.test', name: 'Anil Mehta' };
  const pageErrors = [];
  const listAnswer = () => page.waitForResponse((res) => res.url().includes('/api/v1/organization/getting-started'));

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    ({ token } = await signIn(context, owner));
  });
  test.afterEach(() => {
    const errors = pageErrors.splice(0);
    expect(errors, 'script errors on the page').toEqual([]);
  });
  test.afterAll(async () => {
    await context?.close();
  });

  test('the list shows the seven first steps, none done yet', async () => {
    await page.goto(at('dashboard.html'));
    const card = page.locator('#setupCard');
    await expect(card).toBeVisible();
    await expect(card.locator('.setup-steps li')).toHaveCount(7);
    await expect(card.locator('.setup-steps li.done')).toHaveCount(0);
  });

  test('ready settings for a manufacturer go in with one click', async () => {
    await page.locator('#setupCard [data-kit-open]').click();
    await expect(page.locator('#kitOverlay')).toHaveClass(/open/);
    await page.locator('#kitChoices input[value="manufacturer"]').check();
    await expect(page.locator('#kitPreview .kit-stages li')).toHaveCount(6); // five stages, then Won / Lost
    await expect(page.locator('#kitPreview .kit-replies li')).toHaveCount(7);
    await page.locator('#kitApply').click();
    await expect(page.locator('#kitOverlay')).not.toHaveClass(/open/);
    await expect(page.locator('#setupCard .setup-steps li.done')).toHaveCount(1);

    const pipelines = await api(context, token, 'GET', '/pipelines');
    expect(pipelines.find((pipeline) => pipeline.isDefault).stages.map((stage) => stage.name))
      .toEqual(['New enquiry', 'Requirement understood', 'Sample sent', 'Quotation sent', 'Waiting for PO']);
    expect((await api(context, token, 'GET', '/quick-replies')).length).toBe(7);
    expect((await api(context, token, 'GET', '/organization/billing')).terms).toMatch(/^1\. Prices are ex-works/);
  });

  test('the leads step opens the import box', async () => {
    await page.goto(at('leads.html?import=1'));
    await expect(page.locator('#leadImportOverlay')).toHaveClass(/open/);
  });

  test('hidden for this person on every device, and back from Settings → Your Profile', async () => {
    await page.goto(at('dashboard.html'));
    await page.locator('#setupHide').click();
    await expect(page.locator('#setupCard')).toHaveCount(0);
    const answered = listAnswer();
    await page.reload();
    await answered;
    await page.waitForTimeout(300); // the dashboard has drawn after the answer
    await expect(page.locator('#setupCard')).toHaveCount(0);

    await page.goto(at('Settings.html'));
    await page.locator('#gettingStartedSection a').click();
    await expect(page).toHaveURL(/dashboard\.html$/);
    await expect(page.locator('#setupCard')).toBeVisible();
  });
});

test.describe('The first day in Hindi', () => {
  test('the ready settings come in Hindi, and so do the stages they set', async ({ browser }) => {
    const owner = { email: 'hindi-owner@firstday.test', name: 'Sunita Jain' };
    // Hindi is saved on the account before the sign-in the pages use.
    const setup = await browser.newContext();
    const first = await signIn(setup, owner);
    await api(setup, first.token, 'PATCH', '/auth/preferences', { language: 'hi' });
    await setup.close();

    const context = await browser.newContext();
    const { token } = await signIn(context, owner);
    const page = await context.newPage();
    await page.goto(at('dashboard.html'));
    await page.locator('#setupCard [data-kit-open]').click();
    await expect(page.locator('#kitChoices')).toContainText('ट्रेडर या होलसेलर');
    await page.locator('#kitChoices input[value="trader"]').check();
    await expect(page.locator('#kitPreview')).toContainText('रेट भेजा');
    await page.locator('#kitApply').click();
    await expect(page.locator('#kitOverlay')).not.toHaveClass(/open/);
    const pipelines = await api(context, token, 'GET', '/pipelines');
    expect(pipelines.find((pipeline) => pipeline.isDefault).stages.map((stage) => stage.name)).toEqual(['नई पूछताछ', 'रेट भेजा', 'कोटेशन भेजा', 'मोलभाव']);
    await context.close();
  });
});
