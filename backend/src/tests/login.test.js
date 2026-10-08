jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const User = require('../models/User');
const TrustedDevice = require('../models/TrustedDevice');
const QrLogin = require('../models/QrLogin');
const AuditLog = require('../models/AuditLog');
const env = require('../config/env');
const { codeFor } = require('../services/otpService');
const { api, bearer, login } = require('./helpers/api');

// Signing in like WhatsApp Web (D58): Google, then the mobile number, then a WhatsApp code —
// all three on a new browser; "stay logged in" remembers the browser for 30 days; or scan the
// computer's QR code with a phone that is signed in.
const google = (email, cookie) => {
  const req = api().post('/api/v1/auth/google').send({ credential: `test:sub-${email}:${email}:${email.split('@')[0]}` });
  return cookie ? req.set('Cookie', cookie) : req;
};
const cookieOf = (res, name) => (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`))?.split(';')[0];

describe('Signing in with Google, the mobile number and a WhatsApp code', () => {
  beforeAll(() => {
    env.login.whatsappCode = 'required';
  });
  afterAll(() => {
    env.login.whatsappCode = 'off';
  });

  it('needs all three on a new browser, verifies the number the first time, and can remember the browser', async () => {
    const first = await google('two-step@example.com');
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ step: 'whatsapp-code', phoneHint: '', user: { email: 'two-step@example.com' } });
    expect(first.body.data.token).toBeUndefined();
    expect(cookieOf(first, 'crm_refresh')).toBeUndefined();
    const { challenge } = first.body.data;
    // The challenge is not an access token.
    expect((await api().get('/api/v1/auth/me').set(bearer(challenge))).status).toBe(401);

    const sent = await api().post('/api/v1/auth/login/code').send({ challenge, phone: '98290 22222' });
    expect(sent.body.data).toMatchObject({ sent: true });
    expect(sent.body.data.devCode).toBeUndefined(); // never on screen (D60): in development the server log has it
    const devCode = codeFor('+919829022222');
    const wrong = devCode === '000000' ? '111111' : '000000';
    expect((await api().post('/api/v1/auth/login/verify').send({ challenge, phone: '9829022222', code: wrong })).body.code).toBe('OTP_INVALID');
    const done = await api().post('/api/v1/auth/login/verify').send({ challenge, phone: '9829022222', code: devCode, stayLoggedIn: true });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ token: expect.any(String), user: { email: 'two-step@example.com' }, member: { role: 'owner' } });
    expect(cookieOf(done, 'crm_refresh')).toBeTruthy();
    const device = cookieOf(done, 'crm_device');
    expect(device).toBeTruthy();
    expect((await api().get('/api/v1/auth/me').set(bearer(done.body.data.token))).status).toBe(200);
    expect(await User.findOne({ email: 'two-step@example.com' })).toMatchObject({ phoneE164: '+919829022222' });
    expect(await AuditLog.exists({ action: 'auth.login', 'changes.method': 'google+whatsapp' })).toBeTruthy();

    // The remembered browser: Google alone.
    const again = await google('two-step@example.com', device);
    expect(again.body.data.token).toEqual(expect.any(String));
    // Another browser: all three again, and only this account's number is accepted.
    const elsewhere = (await google('two-step@example.com')).body.data;
    expect(elsewhere).toMatchObject({ step: 'whatsapp-code', phoneHint: '+91 ••••• 2222', phone: '+919829022222' }); // filled in
    expect((await api().post('/api/v1/auth/login/code').send({ challenge: elsewhere.challenge, phone: '9829033333' })).body.code).toBe('PHONE_MISMATCH');

    // Signing out forgets the browser.
    expect((await api().post('/api/v1/auth/logout').set('Cookie', device)).status).toBe(200);
    expect(await TrustedDevice.countDocuments()).toBe(0);
    expect((await google('two-step@example.com', device)).body.data.step).toBe('whatsapp-code');
  });

  it('refuses another person\'s number, a stale sign-in and a code for someone else', async () => {
    const other = (await google('second@example.com')).body.data;
    expect((await api().post('/api/v1/auth/login/code').send({ challenge: other.challenge, phone: '9829022222' })).body.code).toBe('PHONE_IN_USE');
    expect((await api().post('/api/v1/auth/login/code').send({ challenge: 'not-a-token', phone: '9829044444' })).body.code).toBe('LOGIN_EXPIRED');
    // A code sent for one person does not sign in another.
    const mine = (await google('third@example.com')).body.data;
    await api().post('/api/v1/auth/login/code').send({ challenge: mine.challenge, phone: '9829055555' });
    const code = codeFor('+919829055555');
    expect((await api().post('/api/v1/auth/login/verify').send({ challenge: other.challenge, phone: '9829055555', code })).body.code).toBe('OTP_INVALID');
  });

  it('can send the code by SMS instead (MSG91), and says so when SMS is off', async () => {
    const start = (await google('sms-user@example.com')).body.data;
    expect(start).toMatchObject({ smsBackup: true, phone: '' });
    const sent = await api().post('/api/v1/auth/login/code').send({ challenge: start.challenge, phone: '9829077770', channel: 'sms' });
    expect(sent.body.data).toMatchObject({ sent: true, channel: 'sms' });
    expect((await api().post('/api/v1/auth/login/verify').send({ challenge: start.challenge, phone: '9829077770', code: codeFor('+919829077770') })).status).toBe(200);
    expect(await AuditLog.exists({ action: 'auth.login', 'changes.method': 'google+sms' })).toBeTruthy();

    const saved = { ...env.sms };
    Object.assign(env.sms, { provider: 'msg91', msg91AuthKey: 'test-msg91-key', msg91TemplateId: 'tmpl-login' });
    const calls = [];
    let ok = true;
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
      calls.push({ url: String(url), options });
      // MSG91 can answer an error with HTTP 200.
      return new Response(JSON.stringify(ok ? { type: 'success', request_id: 'req-1' } : { type: 'error', message: 'Template not approved by DLT' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const again = (await google('sms-user@example.com')).body.data;
      expect(again.phone).toBe('+919829077770');
      const asked = await api().post('/api/v1/auth/login/code').send({ challenge: again.challenge, phone: again.phone, channel: 'sms' });
      expect(asked.body.data.devCode).toBeUndefined();
      const url = new URL(calls[0].url);
      expect(`${url.origin}${url.pathname}`).toBe('https://control.msg91.com/api/v5/otp');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ template_id: 'tmpl-login', mobile: '919829077770', otp: expect.stringMatching(/^\d{6}$/), otp_expiry: '5' });
      expect(calls[0].options.headers.authkey).toBe('test-msg91-key');
      ok = false;
      const refused = await api().post('/api/v1/auth/login/code').send({ challenge: again.challenge, phone: again.phone, channel: 'sms' });
      expect(refused.body).toMatchObject({ code: 'OTP_NOT_SENT', message: expect.stringContaining('Template not approved by DLT') });
      env.sms.provider = 'off';
      expect((await google('sms-user@example.com')).body.data.smsBackup).toBe(false);
      expect((await api().post('/api/v1/auth/login/code').send({ challenge: again.challenge, phone: again.phone, channel: 'sms' })).body.code).toBe('SMS_OFF');
    } finally {
      spy.mockRestore();
      Object.assign(env.sms, saved);
    }
  });

  it('signs in with Google alone when codes cannot be sent', async () => {
    const saved = env.otp.provider;
    env.otp.provider = 'off';
    try {
      expect((await google('no-codes@example.com')).body.data.token).toEqual(expect.any(String));
    } finally {
      env.otp.provider = saved;
    }
  });
});

describe('2-step verification is optional (D60)', () => {
  beforeAll(() => {
    env.login.whatsappCode = 'optional';
  });
  afterAll(() => {
    env.login.whatsappCode = 'off';
  });

  it('asks for the code only when the person switched it on, with a verified number', async () => {
    const first = await google('optional@example.com');
    expect(first.body.data.token).toEqual(expect.any(String)); // Google alone by default
    const { token } = first.body.data;
    expect((await api().put('/api/v1/auth/two-step').set(bearer(token)).send({ enabled: true })).body.code).toBe('PHONE_REQUIRED');

    await api().post('/api/v1/auth/phone/request').set(bearer(token)).send({ phone: '9829088880' });
    await api().post('/api/v1/auth/phone/verify').set(bearer(token)).send({ phone: '9829088880', code: codeFor('+919829088880') });
    const on = await api().put('/api/v1/auth/two-step').set(bearer(token)).send({ enabled: true });
    expect(on.body.data).toMatchObject({ twoStep: true, twoStepMode: 'optional', phone: '+919829088880' });
    expect(await AuditLog.exists({ action: 'auth.two_step_on' })).toBeTruthy();

    const next = (await google('optional@example.com')).body.data;
    expect(next).toMatchObject({ step: 'whatsapp-code', phone: '+919829088880' });
    await api().post('/api/v1/auth/login/code').send({ challenge: next.challenge, phone: next.phone });
    expect((await api().post('/api/v1/auth/login/verify').send({ challenge: next.challenge, phone: next.phone, code: codeFor('+919829088880') })).status).toBe(200);

    // Removing the number switches it off again.
    expect((await api().delete('/api/v1/auth/phone').set(bearer(token))).body.data).toMatchObject({ twoStep: false });
    expect((await google('optional@example.com')).body.data.token).toEqual(expect.any(String));
  });

  it('cannot be changed per person when the CRM fixes it', async () => {
    const someone = await login('fixed-two-step@example.com');
    env.login.whatsappCode = 'off';
    try {
      expect((await api().put('/api/v1/auth/two-step').set(bearer(someone.token)).send({ enabled: true })).body.code).toBe('TWO_STEP_FIXED');
    } finally {
      env.login.whatsappCode = 'optional';
    }
  });
});

describe('Logging in a computer from the phone (QR)', () => {
  it('shows a code, lets a signed-in phone allow it once, and then the computer is in', async () => {
    const phone = await login('qr-owner@example.com', { name: 'Asha' });
    const started = await api().post('/api/v1/auth/qr').set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36').send({});
    expect(started.status).toBe(200);
    const { id, secret, image } = started.body.data;
    expect(image).toMatch(/^data:image\/png;base64,/);
    expect((await QrLogin.findById(id)).secretHash).not.toBe(secret);
    const poll = (body = {}) => api().post(`/api/v1/auth/qr/${id}/poll`).send({ secret, ...body });
    expect((await poll()).body.data).toEqual({ status: 'pending' });
    expect((await api().post(`/api/v1/auth/qr/${id}/peek`).send({ secret })).status).toBe(401); // the phone must be signed in
    expect((await api().post(`/api/v1/auth/qr/${id}/peek`).set(bearer(phone.token)).send({ secret: 'x'.repeat(43) })).body.code).toBe('QR_NOT_FOUND');
    expect((await api().post(`/api/v1/auth/qr/${id}/peek`).set(bearer(phone.token)).send({ secret })).body.data).toMatchObject({ computer: 'Chrome on Windows' });

    expect((await api().post(`/api/v1/auth/qr/${id}/approve`).set(bearer(phone.token)).send({ secret })).body.data).toMatchObject({ allowed: true, computer: 'Chrome on Windows' });
    const signedIn = await poll({ stayLoggedIn: true });
    expect(signedIn.body.data).toMatchObject({ status: 'approved', token: expect.any(String), organizationId: phone.data.organizationId, user: { email: 'qr-owner@example.com' } });
    expect(cookieOf(signedIn, 'crm_refresh')).toBeTruthy();
    expect(cookieOf(signedIn, 'crm_device')).toBeTruthy();
    expect((await poll()).body.data).toEqual({ status: 'expired' }); // once only
    expect(await AuditLog.exists({ action: 'auth.computer_linked' })).toBeTruthy();
  });

  it('can be declined, and expires', async () => {
    const phone = await login('qr-decline@example.com');
    const first = (await api().post('/api/v1/auth/qr').send({})).body.data;
    await api().post(`/api/v1/auth/qr/${first.id}/approve`).set(bearer(phone.token)).send({ secret: first.secret, allow: false });
    expect((await api().post(`/api/v1/auth/qr/${first.id}/poll`).send({ secret: first.secret })).body.data).toEqual({ status: 'declined' });
    const second = (await api().post('/api/v1/auth/qr').send({})).body.data;
    await QrLogin.updateOne({ _id: second.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await api().post(`/api/v1/auth/qr/${second.id}/poll`).send({ secret: second.secret })).body.data).toEqual({ status: 'expired' });
    expect((await api().post(`/api/v1/auth/qr/${second.id}/approve`).set(bearer(phone.token)).send({ secret: second.secret })).body.code).toBe('QR_EXPIRED');
  });
});
