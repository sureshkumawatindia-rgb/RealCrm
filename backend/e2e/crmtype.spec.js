const { test, expect } = require('@playwright/test');
const { signIn, api, page: at } = require('./helpers');

// CRM types (docs/CRM_TYPES_PLAN.md): "CRM Type" sits beside the company name on the company form,
// starts at Business, and what the owner chooses is what Settings → Company shows.
test.describe.serial('CRM type', () => {
  let context;
  let page;
  const owner = { email: 'owner@crmtype.test', name: 'Ravi Sharma' };
  const pageErrors = [];

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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

  test('the company form has it beside the name, at Business', async () => {
    await page.goto(at('company.html'));
    const type = page.locator('#cCrmType');
    await expect(type).toHaveValue('business');
    await expect(type.locator('option')).toHaveText(['Business', 'Pest Control', 'Trader / Wholesaler', 'Manufacturer', 'Real Estate', 'Education / Coaching', 'Clinic / Hospital', 'Travel Agency', 'Insurance / Loan Agent', 'Salon / Spa', 'Gym / Fitness', 'Interior / Construction', 'Solar Installer']);
    const nameBox = await page.locator('#cName').boundingBox();
    const typeBox = await type.boundingBox();
    expect(Math.abs(typeBox.y - nameBox.y)).toBeLessThan(4);
    expect(typeBox.x).toBeGreaterThanOrEqual(nameBox.x + nameBox.width);
  });

  test('Pest Control is saved, and Settings shows it', async () => {
    await page.locator('#cName').fill('Sharma Pest Control');
    await page.locator('#cCrmType').selectOption('pest_control');
    await page.locator('#saveBtn').click();
    await page.waitForURL(/dashboard\.html/);
    await page.goto(at('Settings.html?tab=company'));
    await expect(page.locator('#cCrmType')).toHaveValue('pest_control');
    await expect(page.locator('#cCrmType')).toBeVisible();
  });

  test('on a phone it sits under the name and the page does not run sideways', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(at('company.html'));
    await expect(page.locator('#cCrmType')).toHaveValue('pest_control');
    const nameBox = await page.locator('#cName').boundingBox();
    const typeBox = await page.locator('#cCrmType').boundingBox();
    expect(typeBox.y).toBeGreaterThan(nameBox.y + nameBox.height);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);
  });

  test('its words are in Hindi for a Hindi user', async ({ browser }) => {
    const hindiOwner = { email: 'hindi@crmtype.test', name: 'Meena Gupta' };
    const setup = await browser.newContext();
    const { token } = await signIn(setup, hindiOwner);
    await api(setup, token, 'PATCH', '/auth/preferences', { language: 'hi' });
    await setup.close();
    const hindi = await browser.newContext();
    const hindiPage = await hindi.newPage();
    await signIn(hindi, hindiOwner);
    await hindiPage.goto(at('company.html'));
    await expect(hindiPage.locator('label[for="cCrmType"]')).toHaveText('CRM का प्रकार');
    await expect(hindiPage.locator('#cCrmType option')).toHaveText(['बिज़नेस', 'पेस्ट कंट्रोल', 'ट्रेडर / होलसेलर', 'मैन्युफ़ैक्चरर', 'रियल एस्टेट', 'शिक्षा / कोचिंग', 'क्लिनिक / अस्पताल', 'ट्रैवल एजेंसी', 'इंश्योरेंस / लोन एजेंट', 'सैलून / स्पा', 'जिम / फ़िटनेस', 'इंटीरियर / कंस्ट्रक्शन', 'सोलर इंस्टॉलर']);
    await hindi.close();
  });

  const menu = (href) => page.locator(`.sidebar a.nav-item[href$="${href}"]`);

  test('a pest control company reads its own words in the menu and on the pages', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(at('dashboard.html'));
    await expect(menu('leads.html')).toHaveText(/Enquiries/);
    await expect(menu('Deals.html')).toHaveText(/Jobs/);
    await expect(menu('Products.html')).toHaveText(/Treatments/);
    await expect(menu('projects.html')).not.toHaveCSS('display', 'none'); // Projects carries the AMC visits
    await page.goto(at('leads.html'));
    await expect(page.locator('.topbar h2')).toHaveText(/Enquiries/);
    await expect(page).toHaveTitle(/Enquiries/);
  });

  test('on a short screen the open menu group scrolls and is not cut off', async () => {
    const submenu = page.locator('.nav-submenu[data-submenu="sales"]');
    await expect(submenu).toHaveClass(/open/);
    await expect.poll(() => submenu.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    await menu('Orders.html').scrollIntoViewIfNeeded();
    await expect(menu('Orders.html')).toBeInViewport();
  });

  test('its treatments, its AMC records and its AMC visits template are there', async () => {
    await page.goto(at('projects.html'));
    await page.locator('#pjManage').click(); // "Templates and settings"
    await expect(page.locator('#pjTplDialog [data-tpl-open]', { hasText: 'AMC: 4 visits a year' })).toBeVisible();
    await page.goto(at('Products.html'));
    await expect(page.getByText('Termite treatment').first()).toBeVisible();
    await page.goto(at('Settings.html?tab=company'));
    await expect(page.locator('.sidebar a.nav-item', { hasText: 'AMC contracts' })).toBeVisible();
  });

  test('back on Business, the words and the menu are the CRM\'s own again', async () => {
    await page.goto(at('Settings.html?tab=company'));
    await expect(page.locator('#cCrmType')).toHaveValue('pest_control'); // the saved profile has been filled in
    await page.locator('#cCrmType').selectOption('business');
    await page.locator('#companyForm button[type="submit"]').first().click();
    await expect(menu('leads.html')).toHaveText(/Leads/);
    await expect(menu('Deals.html')).toHaveText(/Deals/);
    await expect(menu('Products.html')).toHaveText(/Products/);
    await expect(page.locator('#cCrmType')).toHaveValue('business');
  });

  test('a browser that remembers the old type catches up by itself', async ({ browser }) => {
    const boss = { email: 'boss@crmtype.test', name: 'Boss Bhai' };
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    const { token } = await signIn(other, boss);
    await otherPage.goto(at('dashboard.html'));
    await expect(otherPage.locator('.sidebar a.nav-item[href$="leads.html"]')).toHaveText(/Leads/);
    await api(other, token, 'PATCH', '/organization', { crmType: 'pest_control' });
    await otherPage.goto(at('dashboard.html'));
    await expect(otherPage.locator('.sidebar a.nav-item[href$="leads.html"]')).toHaveText(/Enquiries/);
    await other.close();
  });

  test('a trader reads Enquiries, keeps Deals and Products, and has Transporters', async ({ browser }) => {
    const trader = { email: 'trader@crmtype.test', name: 'Mohan Agarwal' };
    const traderContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const traderPage = await traderContext.newPage();
    const { token } = await signIn(traderContext, trader);
    await api(traderContext, token, 'PATCH', '/organization', { crmType: 'trader' });
    await traderPage.goto(at('dashboard.html'));
    const link = (href) => traderPage.locator(`.sidebar a.nav-item[href$="${href}"]`);
    await expect(link('leads.html')).toHaveText(/Enquiries/);
    await expect(link('Deals.html')).toHaveText(/Deals/);
    await expect(link('Products.html')).toHaveText(/Products/);
    await expect(link('projects.html')).toBeHidden();
    await expect(traderPage.locator('.sidebar a.nav-item', { hasText: 'Transporters' })).toBeVisible();
    await traderContext.close();
  });

  test('a manufacturer reads Enquiries, keeps Projects with its production template, and has Transporters', async ({ browser }) => {
    const maker = { email: 'maker@crmtype.test', name: 'Kavita Jain' };
    const makerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const makerPage = await makerContext.newPage();
    const { token } = await signIn(makerContext, maker);
    await api(makerContext, token, 'PATCH', '/organization', { crmType: 'manufacturer' });
    await makerPage.goto(at('dashboard.html'));
    const link = (href) => makerPage.locator(`.sidebar a.nav-item[href$="${href}"]`);
    await expect(link('leads.html')).toHaveText(/Enquiries/);
    await expect(link('Deals.html')).toHaveText(/Deals/);
    await expect(link('projects.html')).toBeAttached();
    await expect(link('projects.html')).not.toHaveCSS('display', 'none');
    await expect(makerPage.locator('.sidebar a.nav-item', { hasText: 'Transporters' })).toBeVisible();
    await makerPage.goto(at('projects.html'));
    await makerPage.locator('#pjManage').click(); // "Templates and settings"
    await expect(makerPage.locator('#pjTplDialog [data-tpl-open]', { hasText: 'Production order' })).toBeVisible();
    await makerContext.close();
  });

  test('a property dealer reads Enquiries, has Properties, and Projects is hidden', async ({ browser }) => {
    const dealer = { email: 'estate@crmtype.test', name: 'Neha Kapoor' };
    const dealerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const dealerPage = await dealerContext.newPage();
    const { token } = await signIn(dealerContext, dealer);
    await api(dealerContext, token, 'PATCH', '/organization', { crmType: 'real_estate' });
    await dealerPage.goto(at('dashboard.html'));
    const link = (href) => dealerPage.locator(`.sidebar a.nav-item[href$="${href}"]`);
    await expect(link('leads.html')).toHaveText(/Enquiries/);
    await expect(link('Deals.html')).toHaveText(/Deals/);
    await expect(link('projects.html')).toBeHidden();
    await expect(dealerPage.locator('.sidebar a.nav-item', { hasText: 'Properties' })).toBeVisible();
    await dealerContext.close();
  });

  test('an institute reads Enquiries, Admissions and Courses, and has Batches and Projects', async ({ browser }) => {
    const institute = { email: 'edu@crmtype.test', name: 'Anita Rao' };
    const instituteContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const institutePage = await instituteContext.newPage();
    const { token } = await signIn(instituteContext, institute);
    await api(instituteContext, token, 'PATCH', '/organization', { crmType: 'education' });
    await institutePage.goto(at('dashboard.html'));
    const link = (href) => institutePage.locator(`.sidebar a.nav-item[href$="${href}"]`);
    await expect(link('leads.html')).toHaveText(/Enquiries/);
    await expect(link('Deals.html')).toHaveText(/Admissions/);
    await expect(link('Products.html')).toHaveText(/Courses/);
    await expect(link('projects.html')).not.toHaveCSS('display', 'none');
    await expect(institutePage.locator('.sidebar a.nav-item', { hasText: 'Batches' })).toBeVisible();
    await instituteContext.close();
  });

  test('a clinic reads Patients, Enquiries, Cases and Treatments, in Hindi मरीज़ too, and has Doctors', async ({ browser }) => {
    const clinicOwner = { email: 'clinic@crmtype.test', name: 'Dr Asha Menon' };
    const clinicContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const clinicPage = await clinicContext.newPage();
    const { token } = await signIn(clinicContext, clinicOwner);
    await api(clinicContext, token, 'PATCH', '/organization', { crmType: 'clinic' });
    await clinicPage.goto(at('dashboard.html'));
    const link = (href) => clinicPage.locator(`.sidebar a.nav-item[href$="${href}"]`);
    await expect(link('customers.html')).toHaveText(/Patients/);
    await expect(link('customer-360.html')).toHaveText(/Patient 360/);
    await expect(link('leads.html')).toHaveText(/Enquiries/);
    await expect(link('Deals.html')).toHaveText(/Cases/);
    await expect(link('Products.html')).toHaveText(/Treatments/);
    await expect(clinicPage.locator('.sidebar a.nav-item', { hasText: 'Doctors' })).toBeVisible();
    await clinicContext.close();

    const hindiOwner = { email: 'clinic-hi@crmtype.test', name: 'Dr Ravi Kumar' };
    const setup = await browser.newContext();
    const { token: hindiToken } = await signIn(setup, hindiOwner);
    await api(setup, hindiToken, 'PATCH', '/auth/preferences', { language: 'hi' });
    await api(setup, hindiToken, 'PATCH', '/organization', { crmType: 'clinic' });
    await setup.close();
    const hindi = await browser.newContext();
    const hindiPage = await hindi.newPage();
    await signIn(hindi, hindiOwner);
    await hindiPage.goto(at('customers.html'));
    await expect(hindiPage.locator('.sidebar a.nav-item[href$="customers.html"]')).toHaveText(/मरीज़/);
    await expect(hindiPage.locator('.topbar h2')).toHaveText(/मरीज़/);
    await hindi.close();
  });

  test('a travel agency reads Enquiries, Trips and Packages (ट्रिप, पैकेज in Hindi), and has Suppliers', async ({ browser }) => {
    const agent = { email: 'travel@crmtype.test', name: 'Vikram Sethi' };
    const agentContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const agentPage = await agentContext.newPage();
    const { token } = await signIn(agentContext, agent);
    await api(agentContext, token, 'PATCH', '/organization', { crmType: 'travel' });
    await agentPage.goto(at('dashboard.html'));
    const link = (href) => agentPage.locator(`.sidebar a.nav-item[href$="${href}"]`);
    await expect(link('leads.html')).toHaveText(/Enquiries/);
    await expect(link('Deals.html')).toHaveText(/Trips/);
    await expect(link('Products.html')).toHaveText(/Packages/);
    await expect(link('projects.html')).toBeHidden();
    await expect(agentPage.locator('.sidebar a.nav-item', { hasText: 'Suppliers' })).toBeVisible();
    await agentContext.close();

    const hindiAgent = { email: 'travel-hi@crmtype.test', name: 'Pooja Nair' };
    const setup = await browser.newContext();
    const { token: hindiToken } = await signIn(setup, hindiAgent);
    await api(setup, hindiToken, 'PATCH', '/auth/preferences', { language: 'hi' });
    await api(setup, hindiToken, 'PATCH', '/organization', { crmType: 'travel' });
    await setup.close();
    const hindi = await browser.newContext();
    const hindiPage = await hindi.newPage();
    await signIn(hindi, hindiAgent);
    await hindiPage.goto(at('Deals.html'));
    await expect(hindiPage.locator('.sidebar a.nav-item[href$="Deals.html"]')).toHaveText(/ट्रिप/);
    await expect(hindiPage.locator('.sidebar a.nav-item[href$="Products.html"]')).toHaveText(/पैकेज/);
    await hindi.close();
  });

  test('an agent reads Clients, Enquiries and Cases, and has Policies and Projects', async ({ browser }) => {
    const agent = { email: 'insurance@crmtype.test', name: 'Suresh Iyer' };
    const agentContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const agentPage = await agentContext.newPage();
    const { token } = await signIn(agentContext, agent);
    await api(agentContext, token, 'PATCH', '/organization', { crmType: 'insurance' });
    await agentPage.goto(at('dashboard.html'));
    const link = (href) => agentPage.locator(`.sidebar a.nav-item[href$="${href}"]`);
    await expect(link('customers.html')).toHaveText(/Clients/);
    await expect(link('leads.html')).toHaveText(/Enquiries/);
    await expect(link('Deals.html')).toHaveText(/Cases/);
    await expect(link('Products.html')).toHaveText(/Products/);
    await expect(link('projects.html')).not.toHaveCSS('display', 'none');
    await expect(agentPage.locator('.sidebar a.nav-item', { hasText: 'Policies' })).toBeVisible();
    await agentContext.close();
  });

  test('a salon reads Clients, Enquiries, Bookings (बुकिंग in Hindi) and Services', async ({ browser }) => {
    const salonOwner = { email: 'salon@crmtype.test', name: 'Ritu Malhotra' };
    const salonContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const salonPage = await salonContext.newPage();
    const { token } = await signIn(salonContext, salonOwner);
    await api(salonContext, token, 'PATCH', '/organization', { crmType: 'salon' });
    await salonPage.goto(at('dashboard.html'));
    const link = (href) => salonPage.locator(`.sidebar a.nav-item[href$="${href}"]`);
    await expect(link('customers.html')).toHaveText(/Clients/);
    await expect(link('leads.html')).toHaveText(/Enquiries/);
    await expect(link('Deals.html')).toHaveText(/Bookings/);
    await expect(link('Products.html')).toHaveText(/Services/);
    await expect(link('projects.html')).not.toHaveCSS('display', 'none');
    await salonContext.close();

    const hindiOwner = { email: 'salon-hi@crmtype.test', name: 'Kiran Bedi' };
    const setup = await browser.newContext();
    const { token: hindiToken } = await signIn(setup, hindiOwner);
    await api(setup, hindiToken, 'PATCH', '/auth/preferences', { language: 'hi' });
    await api(setup, hindiToken, 'PATCH', '/organization', { crmType: 'salon' });
    await setup.close();
    const hindi = await browser.newContext();
    const hindiPage = await hindi.newPage();
    await signIn(hindi, hindiOwner);
    await hindiPage.goto(at('Deals.html'));
    await expect(hindiPage.locator('.sidebar a.nav-item[href$="Deals.html"]')).toHaveText(/बुकिंग/);
    await expect(hindiPage.locator('.topbar h2')).toHaveText(/बुकिंग/);
    await hindi.close();
  });

  test('a gym reads Enquiries and Packages, keeps Customers (not "members"), and has Memberships', async ({ browser }) => {
    const gymOwner = { email: 'gym@crmtype.test', name: 'Arjun Thakur' };
    const gymContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const gymPage = await gymContext.newPage();
    const { token } = await signIn(gymContext, gymOwner);
    await api(gymContext, token, 'PATCH', '/organization', { crmType: 'gym' });
    await gymPage.goto(at('dashboard.html'));
    const link = (href) => gymPage.locator(`.sidebar a.nav-item[href$="${href}"]`);
    await expect(link('customers.html')).toHaveText(/Customers/);
    await expect(link('leads.html')).toHaveText(/Enquiries/);
    await expect(link('Products.html')).toHaveText(/Packages/);
    await expect(gymPage.locator('.sidebar a.nav-item', { hasText: 'Memberships' })).toBeVisible();
    await gymContext.close();
  });

  test('an interior firm reads Clients and Enquiries, has Vendors, and its 45-day project template', async ({ browser }) => {
    const firm = { email: 'interior@crmtype.test', name: 'Nikhil Joshi' };
    const firmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const firmPage = await firmContext.newPage();
    const { token } = await signIn(firmContext, firm);
    await api(firmContext, token, 'PATCH', '/organization', { crmType: 'interior' });
    await firmPage.goto(at('dashboard.html'));
    const link = (href) => firmPage.locator(`.sidebar a.nav-item[href$="${href}"]`);
    await expect(link('customers.html')).toHaveText(/Clients/);
    await expect(link('leads.html')).toHaveText(/Enquiries/);
    await expect(link('projects.html')).not.toHaveCSS('display', 'none');
    await expect(firmPage.locator('.sidebar a.nav-item', { hasText: 'Vendors' })).toBeVisible();
    await firmPage.goto(at('projects.html'));
    await firmPage.locator('#pjManage').click();
    await expect(firmPage.locator('#pjTplDialog [data-tpl-open]', { hasText: 'Interior project: 45 days' })).toBeVisible();
    await firmContext.close();
  });

  test('a solar installer reads Enquiries, has Installations and its rooftop project template', async ({ browser }) => {
    const installer = { email: 'solar@crmtype.test', name: 'Prakash Solanki' };
    const installerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const installerPage = await installerContext.newPage();
    const { token } = await signIn(installerContext, installer);
    await api(installerContext, token, 'PATCH', '/organization', { crmType: 'solar' });
    await installerPage.goto(at('dashboard.html'));
    await expect(installerPage.locator('.sidebar a.nav-item[href$="leads.html"]')).toHaveText(/Enquiries/);
    await expect(installerPage.locator('.sidebar a.nav-item', { hasText: 'Installations' })).toBeVisible();
    await installerPage.goto(at('projects.html'));
    await installerPage.locator('#pjManage').click();
    await expect(installerPage.locator('#pjTplDialog [data-tpl-open]', { hasText: 'Rooftop solar: 30 days' })).toBeVisible();
    await installerContext.close();
  });

  test('in Hindi too, with the screen names of other companies left alone', async ({ browser }) => {
    const hindiOwner = { email: 'hindi2@crmtype.test', name: 'Sunita Verma' };
    const setup = await browser.newContext();
    const { token } = await signIn(setup, hindiOwner);
    await api(setup, token, 'PATCH', '/auth/preferences', { language: 'hi' });
    await api(setup, token, 'PATCH', '/organization', { crmType: 'pest_control' });
    await setup.close();
    const hindi = await browser.newContext();
    const hindiPage = await hindi.newPage();
    await signIn(hindi, hindiOwner);
    await hindiPage.goto(at('dashboard.html'));
    await expect(hindiPage.locator('.sidebar a.nav-item[href$="leads.html"]')).toHaveText(/पूछताछ/);
    await expect(hindiPage.locator('.sidebar a.nav-item[href$="Deals.html"]')).toHaveText(/जॉब/);
    await expect(hindiPage.locator('.sidebar a.nav-item[href$="Products.html"]')).toHaveText(/ट्रीटमेंट/);
    await hindi.close();
  });
});
