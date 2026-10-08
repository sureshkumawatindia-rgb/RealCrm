jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const OtpChallenge = require('../models/OtpChallenge');
const env = require('../config/env');
const { api, bearer, login } = require('./helpers/api');

const PHONE = '98290 11111';

// One's own WhatsApp number (Settings → Your Profile) and the codes behind it (Phase 10E); the
// sign-in steps that use them are in login.test.js.
describe('WhatsApp codes for one\'s own number (Phase 10E)', () => {
  let owner;
  beforeAll(async () => {
    owner = await login('otp-owner@example.com', { name: 'Asha' });
  });
  const requestLink = (token, phone = PHONE) => api().post('/api/v1/auth/phone/request').set(bearer(token)).send({ phone });
  const verifyLink = (token, code, phone = PHONE) => api().post('/api/v1/auth/phone/verify').set(bearer(token)).send({ phone, code });

  it('verifies a member\'s own number with a code, once', async () => {
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
    const other = await login('otp-other@example.com');
    expect((await requestLink(other.token)).body.code).toBe('PHONE_IN_USE');
  });

  it('limits codes per number and wrong tries, and codes expire', async () => {
    const someone = await login('otp-limits@example.com');
    const phone = '9829099999';
    await OtpChallenge.deleteMany({});
    const { devCode } = (await requestLink(someone.token, phone)).body.data;
    const wrong = devCode === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) await verifyLink(someone.token, wrong, phone);
    expect((await verifyLink(someone.token, devCode, phone)).body.code).toBe('OTP_LOCKED');
    const second = (await requestLink(someone.token, phone)).body.data.devCode;
    await OtpChallenge.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verifyLink(someone.token, second, phone)).body.code).toBe('OTP_INVALID');
    await requestLink(someone.token, phone);
    const flood = await requestLink(someone.token, phone);
    expect(flood.status).toBe(429);
    expect(flood.body.code).toBe('OTP_TOO_MANY');
  });

  it('sends the code with the platform\'s WhatsApp authentication template', async () => {
    const someone = await login('otp-template@example.com');
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
      const asked = await requestLink(someone.token, '9829077777');
      expect(asked.body.data.devCode).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toMatch(/\/5550001111\/messages$/);
      expect(calls[0].options.headers.Authorization).toBe('Bearer EAAG-platform-otp-token');
      const body = JSON.parse(calls[0].options.body);
      const code = body.template.components[0].parameters[0].text;
      expect(body).toMatchObject({
        to: '919829077777', type: 'template',
        template: { name: 'crm_login_code', language: { code: 'en' }, components: [{ type: 'body' }, { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }] },
      });
      expect((await verifyLink(someone.token, code, '9829077777')).status).toBe(200);
      ok = false;
      // Meta's reason helps whoever sets the template up (outside production).
      expect((await requestLink(someone.token, '9829066666')).body).toMatchObject({ code: 'OTP_NOT_SENT', message: expect.stringContaining('Template not approved') });
      env.otp.provider = 'off';
      expect((await requestLink(someone.token, '9829066666')).body.code).toBe('OTP_OFF');
    } finally {
      spy.mockRestore();
      Object.assign(env.otp, saved);
    }
  });

  it('can remove the number again', async () => {
    expect((await api().delete('/api/v1/auth/phone').set(bearer(owner.token))).body.data).toMatchObject({ phone: '' });
  });
});
