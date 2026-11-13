const { test, expect, devices } = require('@playwright/test');
const { api, page: at } = require('./helpers');

// The phone app (100 phases, phase 7, D119, docs/PHONE_APP.md), on a phone in Hindi with the
// service worker on: installable, the Inbox opens with no network (the chats this phone saved), a
// reply written with no network waits and goes once the network is back — once, also when its
// answer was lost on the way — and signing out deletes what the phone kept.
test.describe.serial('The phone app', () => {
  let context;
  let page;
  let token;
  const owner = { email: 'owner@phone-app.test', name: 'Sunita Jain' };
  const ravi = { phone: '+919829011111', name: 'Ravi Traders' };
  const meena = { phone: '+919829022222', name: 'Meena Textiles' };
  const chats = {};
  const pageErrors = [];

  // The texts of a chat's messages on the server.
  const textsOf = async (conversationId) => (await api(context, token, 'GET', `/conversations/${conversationId}/messages?limit=50`)).map((m) => m.text);
  // This phone's copy of an answer (js/app.js crmDevice), once it is saved.
  const savedOnPhone = (path) => expect.poll(() => page.evaluate((p) => crmDevice.copy(p).then(Boolean), path), { timeout: 20 * 1000 }).toBe(true);
  // Signing out from the page; the question about waiting replies answered with yes or no.
  async function signOut(answer) {
    const asked = page.waitForEvent('dialog');
    await page.evaluate(() => {
      logout();
    });
    const dialog = await asked;
    const question = dialog.message();
    await (answer ? dialog.accept() : dialog.dismiss());
    return question;
  }

  // As e2e/helpers.js signIn, but once per tab: after signing out, the login page stays.
  async function signInOnce(person) {
    const res = await context.request.post('/api/v1/auth/google', { data: { credential: `test:e2e-${person.email}:${person.email}:${person.name}` } });
    const { token: session, user, member } = (await res.json()).data;
    await context.addInitScript(({ sessionToken, userJson, memberJson }) => {
      if (!window.location.pathname.startsWith('/crm/frontend') || window.sessionStorage.getItem('e2e-signed-in')) return;
      window.sessionStorage.setItem('e2e-signed-in', '1');
      if (window.localStorage.getItem('crm_session')) return;
      window.localStorage.setItem('crm_session', sessionToken);
      window.localStorage.setItem('crm_user', userJson);
      window.localStorage.setItem('crm_member', memberJson);
    }, { sessionToken: session, userJson: JSON.stringify(user), memberJson: JSON.stringify(member) });
    return session;
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    // A retry (on GitHub) or a repeat starts again in a company of its own: the first try's chats
    // and replies stay on the same server and would show twice.
    if (testInfo.retry || testInfo.repeatEachIndex) owner.email = `owner-${testInfo.repeatEachIndex}-${testInfo.retry}@phone-app.test`;
    context = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'allow' });
    // The owner works in Hindi: saved on the account before the browser's sign-in.
    const first = await context.request.post('/api/v1/auth/google', { data: { credential: `test:e2e-${owner.email}:${owner.email}:${owner.name}` } });
    await api(context, (await first.json()).data.token, 'PATCH', '/auth/preferences', { language: 'hi' });
    token = await signInOnce(owner);
    await api(context, token, 'POST', '/whatsapp/accounts', { provider: 'mock', name: 'Test number' });
    for (const customer of [ravi, meena]) {
      const { conversationId } = await api(context, token, 'POST', '/dev/simulate/whatsapp-inbound', { from: customer.phone, name: customer.name, type: 'text', text: `Namaste, ${customer.name} here. Rate bhejiye.` });
      chats[customer.name] = conversationId;
    }
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

  test('installable: its description, a service worker and the app\'s files kept on the phone', async () => {
    await page.goto(at('Inbox.html'));
    await expect(page.locator('.conv-item', { hasText: ravi.name })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-app-ready', '1', { timeout: 60 * 1000 });
    // The Hindi description: Hindi shortcuts, maskable icons, the Inbox to open at.
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', 'manifest-hi.webmanifest');
    const manifest = await (await context.request.get(at('manifest-hi.webmanifest'))).json();
    expect(manifest).toMatchObject({ start_url: 'Inbox.html', display: 'standalone', lang: 'hi-IN' });
    expect(manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual(expect.arrayContaining(['192x192 any', '512x512 any', '192x192 maskable', '512x512 maskable']));
    expect(manifest.shortcuts.map((s) => s.name)).toEqual(['इनबॉक्स', 'नया कोटेशन', 'लीड', 'ऑर्डर']);
    // Kept under their revisions: this page, its scripts, the texts, the pages opened most.
    const kept = await page.evaluate(async () => (await (await caches.open('ycrm-app')).keys()).map((request) => decodeURI(new URL(request.url).pathname.replace('/crm/frontend/', ''))));
    expect(kept).toEqual(expect.arrayContaining(['Inbox.html', 'js/app.js', 'js/inbox.js', 'i18n/hi.json', 'dashboard.html', 'Quotations.html', 'login.html', 'offline.html']));
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  });

  test('opens with no network: the chats this phone saved, a chat read before and one of the newest', async () => {
    await page.locator('.conv-item', { hasText: ravi.name }).click();
    await expect(page.locator('#messageList')).toContainText('Rate bhejiye');
    await savedOnPhone(`/conversations/${chats[ravi.name]}/messages?limit=50`);
    // Meena's chat was never opened: one of the newest, kept a few seconds after the list.
    await savedOnPhone(`/conversations/${chats[meena.name]}/messages?limit=50`);
    await context.setOffline(true);
    await page.goto(at('Inbox.html'));
    await expect(page.locator('#crmNet')).toBeVisible();
    await expect(page.locator('#crmNet')).toHaveAttribute('aria-label', /ऑफ़लाइन/);
    await expect(page.locator('.conv-item', { hasText: meena.name })).toBeVisible();
    // The chat read before: from the copy, saying so.
    await page.locator('.conv-item', { hasText: ravi.name }).click();
    await expect(page.locator('#messageList .msg.in')).toContainText('Ravi Traders here');
    await expect(page.locator('#messageList .copy-note')).toContainText('इंटरनेट नहीं है: ये मैसेज इस फ़ोन पर');
    await page.locator('#threadBack').click();
    await page.locator('.conv-item', { hasText: meena.name }).click();
    await expect(page.locator('#messageList .msg.in')).toContainText('Meena Textiles here');
    // Another page kept on the phone opens too; its data says it needs the network.
    await page.goto(at('dashboard.html'));
    await expect(page.locator('.sidebar')).toBeAttached();
    await expect(page.locator('#crmNet')).toBeVisible();
  });

  test('a reply written with no network waits on the phone, and goes once when the network is back', async () => {
    await page.goto(at(`Inbox.html?c=${chats[meena.name]}`));
    await expect(page.locator('#messageList .msg.in')).toContainText('Meena Textiles here');
    const text = 'Jeera ₹250 per kg, kal bhej denge.';
    await page.locator('#composerText').fill(text);
    await page.locator('#composerSend').click();
    const waiting = page.locator('#messageList .msg.pending');
    await expect(waiting).toContainText('₹250 per kg');
    await expect(waiting).toContainText('इंटरनेट का इंतज़ार');
    await expect(page.locator('#crmNet .crm-net__count')).toHaveText('1');
    expect(await textsOf(chats[meena.name])).not.toContain(text);
    await context.setOffline(false);
    await expect(page.locator('#crmNet')).toHaveClass(/is-back/); // "फिर से ऑनलाइन", for a moment
    // Sent when the phone's outbox is empty. The bubbles alone can mislead: the chat opened from
    // the phone's copy, so it is drawn again ("loading…", no bubbles for a moment) when the network
    // is back, and for a moment the sent reply and its waiting bubble can both be there.
    await expect.poll(() => page.evaluate(() => crmOutbox.list().then((items) => items.length)), { timeout: 30 * 1000 }).toBe(0);
    await expect(page.locator('#messageList .msg.out:not(.pending)', { hasText: text })).toHaveCount(1, { timeout: 15 * 1000 });
    await expect(waiting).toHaveCount(0);
    expect((await textsOf(chats[meena.name])).filter((t) => t === text)).toHaveLength(1);
    await expect(page.locator('#crmNet')).toBeHidden({ timeout: 10 * 1000 });
    // The page opened with no network, and its live updates came back by themselves.
    await expect(page.locator('#inboxLive')).toHaveClass(/online/, { timeout: 30 * 1000 });
  });

  test('a reply whose answer was lost on the way goes once, not twice', async () => {
    const text = 'Bill GST ke saath aayega.';
    let lost = 0;
    // The server takes the reply, but its answer never reaches the phone (the 4G dropped).
    await context.route('**/api/v1/conversations/*/messages', async (route) => {
      if (route.request().method() !== 'POST' || lost) return route.continue();
      lost += 1;
      await route.fetch();
      return route.abort('internetdisconnected');
    });
    await page.locator('#composerText').fill(text);
    await page.locator('#composerSend').click();
    await expect(page.locator('#messageList .msg.out:not(.pending)', { hasText: text })).toBeVisible({ timeout: 30 * 1000 });
    await expect(page.locator('#messageList .msg.pending')).toHaveCount(0);
    expect(lost).toBe(1);
    expect((await textsOf(chats[meena.name])).filter((t) => t === text)).toHaveLength(1);
    await context.unroute('**/api/v1/conversations/*/messages');
  });

  test('a reply that waited more than a day is not sent by itself: the person decides', async () => {
    const text = 'Kal tak bhej denge.';
    await context.setOffline(true);
    await page.locator('#composerText').fill(text);
    await page.locator('#composerSend').click();
    await expect(page.locator('#messageList .msg.pending')).toHaveCount(1);
    // The phone then stayed without the network for more than a day.
    await page.evaluate(async () => {
      const [item] = await crmOutbox.list();
      const dayAndHour = 25 * 60 * 60 * 1000;
      await crmDevice.outbox.put({ ...item, createdAt: item.createdAt - dayAndHour, queuedAt: item.queuedAt - dayAndHour });
    });
    await context.setOffline(false);
    const refused = page.locator('#messageList .msg.pending.failed');
    await expect(refused).toContainText('एक दिन से ज़्यादा रुका रहा', { timeout: 30 * 1000 });
    expect(await textsOf(chats[meena.name])).not.toContain(text);
    // It still fits: sent now, once.
    await refused.locator('[data-wait-retry]').click();
    await expect(page.locator('#messageList .msg.out:not(.pending)', { hasText: text })).toBeVisible({ timeout: 30 * 1000 });
    await expect(page.locator('#messageList .msg.pending')).toHaveCount(0);
    expect((await textsOf(chats[meena.name])).filter((t) => t === text)).toHaveLength(1);
  });

  test('signing out asks about a reply still waiting, then deletes what the phone kept', async () => {
    await context.setOffline(true);
    await page.locator('#composerText').fill('Yeh jawab abhi gaya nahi.');
    await page.locator('#composerSend').click();
    await expect(page.locator('#messageList .msg.pending')).toHaveCount(1);
    // "No": still signed in, the reply still waiting.
    expect(await signOut(false)).toContain('अभी गया नहीं है');
    await expect(page).toHaveURL(/Inbox\.html/);
    await expect(page.locator('#messageList .msg.pending')).toHaveCount(1);
    // "Yes": signed out, and nothing of the member's is left on the phone.
    await signOut(true);
    await expect(page).toHaveURL(/login\.html/);
    const left = await page.evaluate(() => new Promise((resolve) => {
      const request = indexedDB.open('ycrm-device');
      request.onsuccess = () => {
        const tx = request.result.transaction(['copies', 'outbox']);
        const copies = tx.objectStore('copies').count();
        const outbox = tx.objectStore('outbox').count();
        tx.oncomplete = () => resolve({ copies: copies.result, outbox: outbox.result });
      };
    }));
    expect(left).toEqual({ copies: 0, outbox: 0 });
    await context.setOffline(false);
    // The reply never reached the customer.
    expect(await textsOf(chats[meena.name])).not.toContain('Yeh jawab abhi gaya nahi.');
  });
});
