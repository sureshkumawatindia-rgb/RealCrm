jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const KnownBrowser = require('../models/KnownBrowser');
const { api, bearer, cookieValue } = require('./helpers/api');

// "New login" alerts (D63): a login from a browser the person never used puts a note in their
// bell (and web push): "New login: Chrome on Windows, 10:42 AM. Not you? Log out that device."
const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';

async function signIn(email, { userAgent = CHROME_WINDOWS, cookie } = {}) {
  let request = api().post('/api/v1/auth/google').set('User-Agent', userAgent);
  if (cookie) request = request.set('Cookie', cookie);
  const res = await request.send({ credential: `test:sub-${email}:${email}:Someone` });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const browserCookie = (res.headers['set-cookie'] || []).find((value) => value.startsWith('crm_browser='));
  return { token: res.body.data.token, browserCookie, cookie: browserCookie && cookieValue(browserCookie) };
}
const alertsOf = async (token) => {
  const res = await api().get('/api/v1/notifications').set(bearer(token));
  return res.body.data.items.filter((note) => note.source === 'login-alert');
};

describe('New login alerts', () => {
  it('says nothing on the very first login, and keeps the browser in a safe cookie', async () => {
    const first = await signIn('alert-first@example.com');
    expect(await alertsOf(first.token)).toEqual([]);
    expect(first.browserCookie).toMatch(/HttpOnly/i);
    expect(first.browserCookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(first.browserCookie).toMatch(/SameSite=Strict/i);
  });

  it('alerts a login from a new browser, and not one from a browser seen before', async () => {
    const usual = await signIn('alert-new@example.com');
    const again = await signIn('alert-new@example.com', { cookie: usual.cookie });
    expect(await alertsOf(again.token)).toEqual([]);

    const stranger = await signIn('alert-new@example.com', { userAgent: SAFARI_IPHONE });
    const [alert, ...more] = await alertsOf(stranger.token);
    expect(more).toEqual([]);
    expect(alert.title).toMatch(/^New login: Safari on iPhone, \d{1,2}:\d{2} (AM|PM)$/);
    expect(alert.body).toBe('Not you? Log out that device.');
    expect(alert.link).toBe('Settings.html?tab=profile#devicesSection');

    // That browser is known from now on.
    const strangerAgain = await signIn('alert-new@example.com', { userAgent: SAFARI_IPHONE, cookie: stranger.cookie });
    expect(await alertsOf(strangerAgain.token)).toHaveLength(1);
  });

  it("does not raise false alarms on people's usual browsers the first time after the update", async () => {
    // Someone who logged in before alerts existed: sessions, but no known browser yet.
    await signIn('alert-before@example.com');
    await KnownBrowser.deleteMany({});
    const usual = await signIn('alert-before@example.com'); // the same browser as their session
    expect(await alertsOf(usual.token)).toEqual([]);
    // From then on the cookie decides: the same kind of browser without it is new.
    const other = await signIn('alert-before@example.com');
    expect(await alertsOf(other.token)).toHaveLength(1);
  });
});
