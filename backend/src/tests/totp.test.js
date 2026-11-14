jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const User = require('../models/User');
const Notification = require('../models/Notification');
const totp = require('../utils/totp');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// 2-step login with an authenticator app (F7): RFC 6238 codes, set up and turned on with the
// app, asked after Google, each code once, backup codes once, a lock after 5 wrong codes, the
// remembered browser, required for owners and admins, and reset by another owner or admin.

const google = (email, cookie) => {
  const request = api().post('/api/v1/auth/google').send({ credential: `test:sub-${email}:${email}:${email.split('@')[0]}` });
  return cookie ? request.set('Cookie', cookie) : request;
};
const codeNow = (secret, offsetSeconds = 0) => totp.codeAt(totp.base32Decode(secret), Date.now() + offsetSeconds * 1000);
// Lets a test use a new code within the same 30 seconds (the CRM refuses a step it has seen).
const forgetLastStep = (email) => User.updateOne({ email }, { $unset: { 'totp.lastStep': 1, 'totp.lockedUntil': 1 }, $set: { 'totp.failedCount': 0 } });

async function turnOn(token) {
  const setup = (await api().post('/api/v1/auth/totp/setup').set(bearer(token))).body.data;
  const on = await api().post('/api/v1/auth/totp/enable').set(bearer(token)).send({ code: codeNow(setup.secret) });
  return { secret: setup.secret.replace(/\s/g, ''), backupCodes: on.body.data.backupCodes, setup, status: on.status };
}

describe('Authenticator codes', () => {
  it('match RFC 6238 and RFC 4648', () => {
    const secret = Buffer.from('12345678901234567890');
    expect([59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000].map((t) => totp.codeAt(secret, t * 1000, 8)))
      .toEqual(['94287082', '07081804', '14050471', '89005924', '69279037', '65353130']);
    expect(totp.base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(totp.base32Decode('MZXW 6YTB OI').toString()).toBe('foobar');
    expect(totp.verify(secret, totp.codeAt(secret, 1111111109000), { now: 1111111109000 + 25000 })).toBe(37037036);
    expect(totp.verify(secret, totp.codeAt(secret, 1111111109000), { now: 1111111109000 + 95000 })).toBeNull(); // too old
  });
});

describe('2-step login with an authenticator app', () => {
  it('turns on, is asked after Google, takes each code once, backup codes once, and locks after 5 wrong codes', async () => {
    const email = 'f7-agent@example.com';
    const owner = await login('f7-boss@example.com');
    const agent = await inviteAndJoin(owner.token, email, { role: 'agent' });
    const setup = (await api().post('/api/v1/auth/totp/setup').set(bearer(agent.token))).body.data;
    expect(setup.qr).toMatch(/^data:image\/png;base64,/);
    expect(setup.url).toMatch(/^otpauth:\/\/totp\/agreem360:f7-agent%40example\.com\?secret=[A-Z2-7]{32}&issuer=agreem360/);
    expect((await api().post('/api/v1/auth/totp/enable').set(bearer(agent.token)).send({ code: '000000' })).body.code).toBe('TOTP_WRONG_CODE');
    const on = await api().post('/api/v1/auth/totp/enable').set(bearer(agent.token)).send({ code: codeNow(setup.secret) });
    expect(on.status).toBe(200);
    expect(on.body.data.backupCodes).toHaveLength(10);
    on.body.data.backupCodes.forEach((code) => expect(code).toMatch(/^[a-hj-np-z2-9]{4}-[a-hj-np-z2-9]{4}$/));
    const secret = setup.secret.replace(/\s/g, '');
    expect((await api().get('/api/v1/members').set(bearer(owner.token))).body.data.find((m) => m.email === email).totpEnabled).toBe(true);

    // After Google: the app's code, not a session.
    const first = (await google(email)).body.data;
    expect(first).toMatchObject({ step: 'authenticator' });
    expect(first.token).toBeUndefined();
    expect((await api().post('/api/v1/auth/login/app').send({ challenge: first.challenge, code: '123456' })).status).toBe(401);
    const code = codeNow(secret, 30); // the next step: the one used to turn it on is spent
    const signedIn = await api().post('/api/v1/auth/login/app').send({ challenge: first.challenge, code });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.token).toBeTruthy();
    // The same code again: refused.
    const again = (await google(email)).body.data;
    expect((await api().post('/api/v1/auth/login/app').send({ challenge: again.challenge, code })).body.code).toBe('TOTP_WRONG_CODE');
    // A backup code works once.
    const backup = on.body.data.backupCodes[0];
    expect((await api().post('/api/v1/auth/login/app').send({ challenge: again.challenge, code: backup.toUpperCase() })).status).toBe(200);
    expect((await api().post('/api/v1/auth/login/app').send({ challenge: again.challenge, code: backup })).status).toBe(401);
    expect((await api().get('/api/v1/auth/totp').set(bearer(signedIn.body.data.token))).body.data).toMatchObject({ enabled: true, backupCodesLeft: 9, required: false });

    // Five wrong codes: locked, even for the right one.
    await forgetLastStep(email);
    for (let i = 0; i < 4; i += 1) await api().post('/api/v1/auth/login/app').send({ challenge: again.challenge, code: '000000' });
    expect((await api().post('/api/v1/auth/login/app').send({ challenge: again.challenge, code: '000000' })).status).toBe(401);
    expect((await api().post('/api/v1/auth/login/app').send({ challenge: again.challenge, code: codeNow(secret) })).body.code).toBe('TOTP_LOCKED');

    // "Stay logged in on this browser": next time Google alone.
    await forgetLastStep(email);
    const kept = await api().post('/api/v1/auth/login/app').send({ challenge: again.challenge, code: codeNow(secret), stayLoggedIn: true });
    const cookie = (kept.headers['set-cookie'] || []).find((c) => c.startsWith('crm_device='));
    expect(cookie).toBeTruthy();
    expect((await google(email, cookie.split(';')[0])).body.data.token).toBeTruthy();

    // An agent may turn it off with a code.
    await forgetLastStep(email);
    expect((await api().post('/api/v1/auth/totp/disable').set(bearer(signedIn.body.data.token)).send({ code: codeNow(secret) })).body.data).toEqual({ enabled: false });
    expect((await google(email)).body.data.token).toBeTruthy();
  });

  it('is required for owners and admins after the grace days, and others reset it', async () => {
    const owner = await login('f7-owner@example.com');
    // First seen: 7 days to turn it on; the pages say by when.
    await api().get('/api/v1/auth/me').set(bearer(owner.token));
    const before = (await api().get('/api/v1/auth/me').set(bearer(owner.token))).body.data.twoFactor;
    expect(before).toMatchObject({ enabled: false, required: true });
    expect(new Date(before.requiredBy).getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect((await api().get('/api/v1/leads').set(bearer(owner.token))).status).toBe(200);
    // Past it: only the sign-in pages (where the set-up is) answer.
    await User.updateOne({ email: 'f7-owner@example.com' }, { $set: { 'totp.requiredBy': new Date(Date.now() - 1000) } });
    expect((await api().get('/api/v1/leads').set(bearer(owner.token))).body.code).toBe('TOTP_SETUP_REQUIRED');
    expect((await api().get('/api/v1/auth/me').set(bearer(owner.token))).status).toBe(200);
    const { status } = await turnOn(owner.token);
    expect(status).toBe(200);
    expect((await api().get('/api/v1/leads').set(bearer(owner.token))).status).toBe(200);
    // Owners keep it on.
    expect((await api().post('/api/v1/auth/totp/disable').set(bearer(owner.token)).send({ code: '123456' })).body.code).toBe('TOTP_REQUIRED');

    // An admin who lost the phone: the owner resets it; the admin is told; Google alone next time.
    const admin = await inviteAndJoin(owner.token, 'f7-admin@example.com', { role: 'admin' });
    await turnOn(admin.token);
    const members = (await api().get('/api/v1/members').set(bearer(owner.token))).body.data;
    const adminMember = members.find((m) => m.email === 'f7-admin@example.com');
    const ownerMember = members.find((m) => m.email === 'f7-owner@example.com');
    expect((await api().post(`/api/v1/members/${ownerMember.id}/totp-reset`).set(bearer(admin.token))).status).toBe(403); // an admin, an owner's
    expect((await api().post(`/api/v1/members/${ownerMember.id}/totp-reset`).set(bearer(owner.token))).body.code).toBe('TOTP_RESET_SELF');
    const reset = await api().post(`/api/v1/members/${adminMember.id}/totp-reset`).set(bearer(owner.token));
    expect(reset.body.data.totpEnabled).toBe(false);
    expect(await Notification.countDocuments({ memberId: adminMember.id, title: 'Your 2-step login was turned off' })).toBe(1);
    expect((await google('f7-admin@example.com')).body.data.token).toBeTruthy();
    expect((await User.findOne({ email: 'f7-admin@example.com' })).totp.requiredBy.getTime()).toBeGreaterThan(Date.now()); // a fresh grace period

    // Someone who is also in another company: only support resets them.
    await turnOn((await google('f7-admin@example.com')).body.data.token);
    const other = await login('f7-other-owner@example.com');
    await inviteAndJoin(other.token, 'f7-admin@example.com', { role: 'agent' });
    expect((await api().post(`/api/v1/members/${adminMember.id}/totp-reset`).set(bearer(owner.token))).body.code).toBe('TOTP_RESET_OTHER_COMPANIES');
  });
});
