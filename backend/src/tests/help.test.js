jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const AuditLog = require('../models/AuditLog');
const Organization = require('../models/Organization');
const User = require('../models/User');
const env = require('../config/env');
const totp = require('../utils/totp');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Help inside the CRM (100 phases, phase 6, D118): the platform's support contact is set on the
// platform admin page (behind its authenticator code) and every member of every company reads it
// for the "?" box and the help centre, with their company's name and workspace code.
const ADMIN = 'help-boss@example.com';

describe('The support contact in every company\'s help (D118)', () => {
  let admin;
  let secret;
  let before;
  const support = (who) => api().get('/api/v1/help/support').set(bearer(who.token));
  const putSupport = (who, body) => api().put('/api/v1/platform/support').set(bearer(who.token)).send(body);
  const freshCode = async () => {
    await User.updateOne({ email: ADMIN }, { $unset: { 'totp.lastStep': 1 } });
    return totp.codeAt(totp.base32Decode(secret), Date.now());
  };

  beforeAll(async () => {
    before = env.platformAdminEmails;
    env.platformAdminEmails = [ADMIN];
    admin = await login(ADMIN, { name: 'Help Boss' });
    const setup = (await api().post('/api/v1/auth/totp/setup').set(bearer(admin.token))).body.data;
    secret = setup.secret.replace(/\s/g, '');
    await api().post('/api/v1/auth/totp/enable').set(bearer(admin.token)).send({ code: await freshCode() });
  });
  afterAll(() => {
    env.platformAdminEmails = before;
  });

  it('is empty until a platform admin sets it, and only a platform admin with the code sets it', async () => {
    const owner = await login('help-owner@example.com');
    await Organization.updateOne({ _id: owner.data.organizationId }, { $set: { name: 'Mehta Steel', slug: 'mehta-steel' } });
    expect((await support(owner)).body.data).toEqual({ whatsapp: '', email: '', hours: '', company: { name: 'Mehta Steel', code: 'mehta-steel' } });

    // Not a platform admin: no such page. The admin without this login's code: asked for it.
    expect((await putSupport(owner, { whatsapp: '9829012345' })).status).toBe(404);
    expect((await putSupport(admin, { whatsapp: '9829012345' })).body.code).toBe('PLATFORM_CODE_REQUIRED');
    expect((await api().post('/api/v1/platform/unlock').set(bearer(admin.token)).send({ code: await freshCode() })).status).toBe(200);

    const saved = await putSupport(admin, { whatsapp: '98290 12345', email: 'Help@YellowCRM.in', hours: 'Mon–Sat, 10 am – 7 pm' });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({ whatsapp: '+919829012345', email: 'help@yellowcrm.in', hours: 'Mon–Sat, 10 am – 7 pm' });
    expect((await api().get('/api/v1/platform/support').set(bearer(admin.token))).body.data).toEqual(saved.body.data);
    expect(await AuditLog.exists({ action: 'platform.support_updated', organizationId: admin.data.organizationId })).toBeTruthy();

    // Every member of every company reads it: an agent too.
    const agent = await inviteAndJoin(owner.token, 'help-agent@example.com', { role: 'agent', modules: ['inbox'] });
    expect((await support(agent)).body.data).toMatchObject({ whatsapp: '+919829012345', email: 'help@yellowcrm.in', company: { name: 'Mehta Steel' } });
  });

  it('refuses a number that is not one, and clears what is left empty', async () => {
    await api().post('/api/v1/platform/unlock').set(bearer(admin.token)).send({ code: await freshCode() });
    const wrong = await putSupport(admin, { whatsapp: '12345' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.errors[0]).toMatchObject({ field: 'whatsapp', code: 'INVALID_PHONE' });
    expect((await putSupport(admin, { email: 'not-an-email' })).status).toBe(400);
    expect((await putSupport(admin, { hours: 'x'.repeat(121) })).status).toBe(400);

    await putSupport(admin, { whatsapp: '+44 7700 900123', email: '', hours: '' });
    expect((await support(admin)).body.data).toMatchObject({ whatsapp: '+447700900123', email: '', hours: '' });
    await putSupport(admin, {});
    expect((await support(admin)).body.data).toMatchObject({ whatsapp: '', email: '', hours: '' });
  });

  it('needs a signed-in person', async () => {
    expect((await api().get('/api/v1/help/support')).status).toBe(401);
  });
});
