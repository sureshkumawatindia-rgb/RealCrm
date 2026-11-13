const { test, expect } = require('@playwright/test');
const { signIn, page: at } = require('./helpers');

// The ten flows that must never break (Phase 2 of the 100 phases, D114), one after the other,
// the way a trader's first day goes: sign up, a test WhatsApp number, a customer's message
// becomes a lead, the reply, the quotation, the order, the tax invoice, the payment, the report,
// and a teammate invited and in the Inbox. Each step uses the CRM's own screens.
test.describe.serial('The ten flows that must never break', () => {
  let context;
  let page;
  const owner = { email: 'owner@flows.test', name: 'Suresh Kumar' };
  const customer = { phone: '98290 12345', name: 'Ravi Kumar' };
  let orderUrl = '';
  const pageErrors = [];

  test.beforeAll(async ({ browser }, testInfo) => {
    // A retry (on GitHub) or a repeat signs up again as a new owner: the first try's company is
    // still on the server, and its owner would skip the first steps.
    if (testInfo.retry || testInfo.repeatEachIndex) owner.email = `owner-${testInfo.repeatEachIndex}-${testInfo.retry}@flows.test`;
    context = await browser.newContext();
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await signIn(context, owner);
  });
  // A script error on a page fails the flow it happened in.
  test.afterEach(() => {
    const errors = pageErrors.splice(0);
    expect(errors, 'script errors on the page').toEqual([]);
  });
  test.afterAll(async () => {
    await context?.close();
  });

  test('1. sign up: the first steps end on the dashboard', async () => {
    await page.goto(at('invite-team.html'));
    await page.locator('#skipBtn').click();
    await expect(page).toHaveURL(/company\.html$/);
    // The GSTIN and the address go on the tax invoice (flow 7).
    await page.locator('#cGst').fill('08AAACY1234C1Z5');
    await page.locator('#cAddress').fill('12 MI Road');
    await page.locator('#cCity').fill('Jaipur');
    await page.locator('#cState').fill('Rajasthan');
    await page.locator('#cPincode').fill('302001');
    await page.locator('#saveBtn').click();
    await expect(page).toHaveURL(/dashboard\.html$/);
  });

  test('2. a test WhatsApp number is connected in Settings', async () => {
    await page.goto(at('Settings.html?tab=whatsapp'));
    await page.locator('#waAddMockBtn').click();
    await expect(page.locator('#waAccountList')).toContainText(/test/i);
  });

  test('3. a customer\'s WhatsApp message becomes a lead', async () => {
    await page.locator('#waSimFrom').fill(customer.phone);
    await page.locator('#waSimName').fill(customer.name);
    await page.locator('#waSimText').fill('Jeera ka rate kya hai? 25 kg chahiye.');
    // The message must reach the server before the page is left (leaving cancels the request),
    // and the lead may come a moment later: the Leads page is opened again until it shows.
    const received = page.waitForResponse((res) => res.url().includes('/dev/simulate/whatsapp-inbound') && res.request().method() === 'POST');
    await page.locator('#waSimulateForm [type="submit"]').click();
    expect((await received).ok()).toBe(true);
    await expect(async () => {
      await page.goto(at('leads.html'));
      await expect(page.locator('#leadsTable')).toContainText(customer.name, { timeout: 3000 });
    }).toPass({ timeout: 30 * 1000 });
  });

  test('4. a reply goes from the Inbox', async () => {
    await page.goto(at('Inbox.html'));
    await page.locator('.conv-item', { hasText: customer.name }).click();
    await expect(page.locator('#messageList')).toContainText('Jeera ka rate');
    await page.locator('#composerText').fill('Namaste! 25 kg jeera ₹250 per kg hai.');
    await page.locator('#composerSend').click();
    await expect(page.locator('#messageList .msg.out')).toContainText('₹250 per kg');
  });

  test('5. a quotation is made for the customer and accepted', async () => {
    await page.goto(at('Quotations.html'));
    await page.locator('#qNewBtn').click();
    await page.locator('#qPickerInput').fill('Ravi');
    await page.locator('#qPickerResults .q-pick').first().click();
    await page.locator('#qAddItem').click();
    const line = page.locator('#qItems .q-line[data-key]').last();
    await line.locator('[data-f="name"]').fill('Cumin seeds 25 kg');
    await line.locator('[data-f="quantity"]').fill('2');
    await line.locator('[data-f="price"]').fill('6250');
    await line.locator('[data-f="gst"]').fill('5');
    await page.locator('#qActions [data-action="create"]').click();
    await expect(page.locator('#qNumber')).toContainText(/\d/);
    await page.locator('#qActions [data-action="sent"]').click();
    await expect(page.locator('#qActions [data-action="accepted"]')).toBeVisible();
    await page.locator('#qActions [data-action="accepted"]').click();
    await expect(page.locator('#qActions [data-action="order"]')).toBeVisible();
  });

  test('6. the accepted quotation becomes an order', async () => {
    await page.locator('#qActions [data-action="order"]').click();
    await expect(page).toHaveURL(/Orders\.html\?id=/);
    await expect(page.locator('#oNumber')).toContainText(/\d/);
    await expect(page.locator('#oItems')).toContainText('Cumin seeds 25 kg');
    orderUrl = page.url();
  });

  test('7. the order gets its GST tax invoice', async () => {
    await page.locator('#oInvoice [data-inv-make]').click();
    await page.locator('#invGo').click();
    await expect(page.locator('#oInvoice')).toContainText(/INV\//);
  });

  test('8. the payment is recorded and the order is paid', async () => {
    await page.goto(orderUrl);
    await page.locator('#oPayment [data-pay="record"]').click();
    await expect(page.locator('#payAmount')).toHaveValue('13125.00');
    await page.locator('#payGo').click();
    await expect(page.locator('#oSub')).toContainText(/paid/i);
  });

  test('9. the report counts the money in', async () => {
    await page.goto(at('Reports & Analytics.html'));
    await expect(page.locator('#kpiGrid')).toContainText('13,125');
  });

  test('10. a teammate is invited and works in the Inbox', async ({ browser }) => {
    await page.goto(at('Settings.html?tab=team'));
    await page.locator('#inviteEmail').fill('agent@flows.test');
    await page.locator('#inviteRole').selectOption('agent');
    await page.locator('#inviteSubmitBtn').click();
    await expect(page.locator('#inviteLinkText')).toContainText('invite=');
    const link = (await page.locator('#inviteLinkText').textContent()).trim();
    const inviteToken = new URL(link).searchParams.get('invite');

    const agentContext = await browser.newContext();
    try {
      await signIn(agentContext, { email: 'agent@flows.test', name: 'Asha Agent', inviteToken });
      const agentPage = await agentContext.newPage();
      await agentPage.goto(at('Inbox.html'));
      await expect(agentPage.locator('#inboxSearch')).toBeVisible();
      await expect(agentPage.locator('#conversationList')).toBeVisible();
    } finally {
      await agentContext.close();
    }
  });
});
