jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const TrustedDevice = require('../models/TrustedDevice');
const AuditLog = require('../models/AuditLog');
const env = require('../config/env');
const { api, bearer, login, cookieValue } = require('./helpers/api');

// Settings → Your Profile → "Where you're logged in" (2026-10-08), like WhatsApp's linked
// devices: each browser with a live session; logging one out ends it at once.
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36';
const googleOn = (email, userAgent) => api().post('/api/v1/auth/google').set('User-Agent', userAgent)
  .send({ credential: `test:sub-${email}:${email}:${email.split('@')[0]}` });
const devicesOf = async (token) => (await api().get('/api/v1/auth/devices').set(bearer(token))).body.data.devices;
const me = (token) => api().get('/api/v1/auth/me').set(bearer(token));

describe('Where you\'re logged in', () => {
  it('lists each browser, marks this one, and logs one out at once', async () => {
    const computer = (await googleOn('devices@example.com', CHROME)).body.data;
    const phoneRes = await googleOn('devices@example.com', ANDROID);
    const phone = phoneRes.body.data;

    const devices = await devicesOf(computer.token);
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({ device: 'Chrome on Windows', method: 'google', current: true, rememberedUntil: null });
    expect(devices[1]).toMatchObject({ device: 'Chrome on Android', current: false });
    expect(devices[1].loggedInAt).toEqual(expect.any(String));

    // The phone's token stops working at once, and so does its refresh cookie.
    const out = await api().delete(`/api/v1/auth/devices/${devices[1].id}`).set(bearer(computer.token));
    expect(out.body.data.devices).toHaveLength(1);
    expect((await me(phone.token)).body.code).toBe('SESSION_ENDED');
    const refreshCookie = cookieValue(phoneRes.headers['set-cookie'].find((c) => c.startsWith('crm_refresh=')));
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', refreshCookie)).status).toBe(401);
    expect((await me(computer.token)).status).toBe(200);
    expect(await AuditLog.exists({ action: 'auth.devices_logged_out' })).toBeTruthy();
  });

  it('keeps the entry through token refreshes, logs out all others, and only one\'s own devices', async () => {
    const first = await login('others@example.com');
    const second = await login('others@example.com');
    const third = await login('others@example.com');
    // A refresh keeps the browser's entry (the same family) and how it logged in.
    const refreshed = await api().post('/api/v1/auth/refresh').set('Cookie', cookieValue(first.cookie));
    expect(await devicesOf(refreshed.body.data.token)).toHaveLength(3);

    const stranger = await login('stranger@example.com');
    const theirs = (await devicesOf(second.token)).find((device) => !device.current).id;
    expect((await api().delete(`/api/v1/auth/devices/${theirs}`).set(bearer(stranger.token))).body.code).toBe('DEVICE_NOT_FOUND');
    expect((await api().delete('/api/v1/auth/devices/not-a-uuid').set(bearer(stranger.token))).status).toBe(400);

    const left = await api().post('/api/v1/auth/devices/logout-others').set(bearer(third.token));
    expect(left.body.data.devices).toEqual([expect.objectContaining({ current: true })]);
    expect((await me(second.token)).status).toBe(401);
    expect((await me(refreshed.body.data.token)).status).toBe(401);
    expect((await me(third.token)).status).toBe(200);
  });

  it('logging out from the list forgets a remembered browser too', async () => {
    env.login.whatsappCode = 'required';
    try {
      const { challenge } = (await googleOn('remember@example.com', CHROME)).body.data;
      const { devCode } = (await api().post('/api/v1/auth/login/code').send({ challenge, phone: '9829066660' })).body.data;
      const done = await api().post('/api/v1/auth/login/verify').set('User-Agent', CHROME).send({ challenge, phone: '9829066660', code: devCode, stayLoggedIn: true });
      const deviceCookie = cookieValue(done.headers['set-cookie'].find((c) => c.startsWith('crm_device=')));

      // Google alone on the remembered browser: still one entry, now its new session.
      const again = await googleOn('remember@example.com', CHROME).set('Cookie', deviceCookie);
      const [entry] = (await devicesOf(again.body.data.token)).filter((device) => device.current);
      expect(entry).toMatchObject({ method: 'google', rememberedUntil: expect.any(String) });

      const elsewhere = (await login('remember@example.com', { sub: 'sub-remember@example.com' }));
      expect(elsewhere.data.step).toBe('whatsapp-code'); // a new browser still needs the code
      const other = await api().post('/api/v1/auth/login/verify').send({
        challenge: elsewhere.data.challenge, phone: '9829066660',
        code: (await api().post('/api/v1/auth/login/code').send({ challenge: elsewhere.data.challenge, phone: '9829066660' })).body.data.devCode,
      });
      await api().delete(`/api/v1/auth/devices/${entry.id}`).set(bearer(other.body.data.token));
      expect(await TrustedDevice.countDocuments({ familyId: entry.id })).toBe(0);
      expect((await googleOn('remember@example.com', CHROME).set('Cookie', deviceCookie)).body.data.step).toBe('whatsapp-code');
    } finally {
      env.login.whatsappCode = 'off';
    }
  });

  it('a normal logout ends the access token at once too', async () => {
    const someone = await login('logout-now@example.com');
    await api().post('/api/v1/auth/logout').set('Cookie', cookieValue(someone.cookie));
    expect((await me(someone.token)).body.code).toBe('SESSION_ENDED');
  });
});
