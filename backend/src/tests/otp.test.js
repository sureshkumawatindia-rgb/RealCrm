jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const OtpChallenge = require('../models/OtpChallenge');
const AuditLog = require('../models/AuditLog');
const env = require('../config/env');
const { api, bearer, login } = require('./helpers/api');

const PHONE = '98290 11111';

describe('Phone sign-in with a WhatsApp code (Phase 10E)', () => {
  let owner;
  beforeAll(async () => {
    owner = await login('otp-owner@example.com', { name: 'Asha' });
  });
  const requestLink = (token, phone = PHONE) => api().post('/api/v1/auth/phone/request').set(bearer(token)).send({ phone });
  const verifyLink = (token, code, phone = PHONE) => api().post('/api/v1/auth/phone/verify').set(bearer(token)).send({ phone, code });

  it('verifies a member\'s own number first', async () => {
    expect((await api().get('/api/v1/auth/phone').set(bearer(owner.token))).body.data).toEqual({ phone: '', verifiedAt: null, available: true });
    const sent = (await requestLink(owner.token)).body.data;
    expect(sent).toMatchObject({ sent: true, expiresInSeconds: 300, devCode: expect.stringMatching(/^\d{6}$/) });
    expect((await OtpChallenge.findOne()).codeHash).not.toContain(sent.devCode);
    const wrong = sent.devCode === '000000' ? '111111' : '000000';
    expect((await verifyLink(owner.token, wrong)).body.code).toBe('OTP_INVALID');
    expect((await verifyLink(owner.token, '12ab56')).status).toBe(400);
    const ok = await verifyLink(owner.token, sent.devCode);
    expect(ok.body.data).toMatchObject({ phone: '+919829011111', available: true });
    expect((await verifyLink(owner.token, sent.devCode)).body.code).toBe('OTP_INVALID'); // one use
    // Someone else cannot take the number.
    const other = await login('otp-other@example.com');
    expect((await requestLink(other.token)).body.code).toBe('PHONE_IN_USE');
  });

  it('signs in with a code sent to the verified number', async () => {
    const asked = await api().post('/api/v1/auth/otp/request').send({ phone: '+91 98290-11111' });
    expect(asked.body.data).toMatchObject({ sent: true, message: 'If this number is linked to a CRM account, a 6-digit code is on its way on WhatsApp.' });
    const signedIn = await api().post('/api/v1/auth/otp/verify').send({ phone: PHONE, code: asked.body.data.devCode });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data).toMatchObject({ user: { email: 'otp-owner@example.com' }, organizationId: owner.data.organizationId, member: { role: 'owner' } });
    expect(signedIn.headers['set-cookie'].join(';')).toMatch(/crm_refresh=/);
    expect((await api().get('/api/v1/auth/me').set(bearer(signedIn.body.data.token))).status).toBe(200);
    expect(await AuditLog.exists({ action: 'auth.login', 'changes.method': 'whatsapp-code' })).toBeTruthy();
  });

  it('answers the same for a number nobody uses, and limits tries', async () => {
    const unknown = await api().post('/api/v1/auth/otp/request').send({ phone: '9829099999' });
    expect(unknown.body.data).toEqual({ sent: true, message: 'If this number is linked to a CRM account, a 6-digit code is on its way on WhatsApp.', expiresInSeconds: 300 });
    expect((await api().post('/api/v1/auth/otp/verify').send({ phone: '9829099999', code: '123456' })).body.code).toBe('OTP_INVALID');
    await api().post('/api/v1/auth/otp/request').send({ phone: '9829099999' });
    await api().post('/api/v1/auth/otp/request').send({ phone: '9829099999' });
    const flood = await api().post('/api/v1/auth/otp/request').send({ phone: '9829099999' });
    expect(flood.status).toBe(429);
    expect(flood.body.code).toBe('OTP_TOO_MANY');

    // Five wrong codes lock it; an expired code does not work.
    await OtpChallenge.deleteMany({});
    const { devCode } = (await api().post('/api/v1/auth/otp/request').send({ phone: PHONE })).body.data;
    const wrong = devCode === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) await api().post('/api/v1/auth/otp/verify').send({ phone: PHONE, code: wrong });
    expect((await api().post('/api/v1/auth/otp/verify').send({ phone: PHONE, code: devCode })).body.code).toBe('OTP_LOCKED');
    const second = (await api().post('/api/v1/auth/otp/request').send({ phone: PHONE })).body.data.devCode;
    await OtpChallenge.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await api().post('/api/v1/auth/otp/verify').send({ phone: PHONE, code: second })).body.code).toBe('OTP_INVALID');
  });

  it('sends the code with the platform\'s WhatsApp authentication template', async () => {
    await OtpChallenge.deleteMany({});
    const saved = { ...env.otp };
    Object.assign(env.otp, { provider: 'whatsapp', phoneNumberId: '5550001111', accessToken: 'EAAG-platform-otp-token', template: 'crm_login_code', language: 'en' });
    const calls = [];
    let ok = true;
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify(ok ? { messages: [{ id: 'wamid.OTP1' }] } : { error: { message: 'Template not approved' } }), { status: ok ? 200 : 400, headers: { 'content-type': 'application/json' } });
    });
    try {
      const asked = await api().post('/api/v1/auth/otp/request').send({ phone: PHONE });
      expect(asked.body.data.devCode).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toMatch(/\/5550001111\/messages$/);
      expect(calls[0].options.headers.Authorization).toBe('Bearer EAAG-platform-otp-token');
      const body = JSON.parse(calls[0].options.body);
      const code = body.template.components[0].parameters[0].text;
      expect(body).toMatchObject({
        to: '919829011111', type: 'template',
        template: { name: 'crm_login_code', language: { code: 'en' }, components: [{ type: 'body' }, { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }] },
      });
      expect((await api().post('/api/v1/auth/otp/verify').send({ phone: PHONE, code })).status).toBe(200);
      // A number nobody uses: nothing is sent.
      await api().post('/api/v1/auth/otp/request').send({ phone: '9829088888' });
      expect(calls).toHaveLength(1);
      ok = false;
      expect((await api().post('/api/v1/auth/otp/request').send({ phone: PHONE })).body.code).toBe('OTP_NOT_SENT');
      env.otp.provider = 'off';
      expect((await api().post('/api/v1/auth/otp/request').send({ phone: PHONE })).body.code).toBe('OTP_OFF');
    } finally {
      spy.mockRestore();
      Object.assign(env.otp, saved);
    }
  });

  it('can remove the number again', async () => {
    expect((await api().delete('/api/v1/auth/phone').set(bearer(owner.token))).body.data).toMatchObject({ phone: '' });
    await OtpChallenge.deleteMany({});
    const asked = await api().post('/api/v1/auth/otp/request').send({ phone: PHONE });
    expect(asked.body.data.devCode).toBeUndefined(); // nobody uses it now
  });
});
