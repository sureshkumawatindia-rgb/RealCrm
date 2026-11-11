jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const BillingInvoice = require('../models/BillingInvoice');
const Broadcast = require('../models/Broadcast');
const Contact = require('../models/Contact');
const Organization = require('../models/Organization');
const User = require('../models/User');
const env = require('../config/env');
const totp = require('../utils/totp');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// D104: the platform admin page — only the emails in PLATFORM_ADMIN_EMAILS, with 2-step login by
// the authenticator app, after a code on that login; every company as counts, the money, the
// plan actions (audited in the company) and the go-live checklist (never a key's value).
const DAY = 24 * 60 * 60 * 1000;
const ADMIN = 'platform-boss@example.com';
const codeAt = (secret, offsetSeconds = 0) => totp.codeAt(totp.base32Decode(secret), Date.now() + offsetSeconds * 1000);

describe('Platform admin page (D104)', () => {
  let admin;
  let stranger;
  let secret;
  const get = (who, path) => api().get(`/api/v1/platform${path}`).set(bearer(who.token));
  const post = (who, path, body = {}) => api().post(`/api/v1/platform${path}`).set(bearer(who.token)).send(body);
  // The app never takes a 30-second step twice: forget the last one, then the code of now.
  const freshCode = async () => {
    await User.updateOne({ email: ADMIN }, { $unset: { 'totp.lastStep': 1 } });
    return codeAt(secret);
  };
  const companyNamed = async (email, name, set = {}) => {
    const who = await login(email);
    await Organization.updateOne({ _id: who.data.organizationId }, { $set: { name, ...set } });
    return who;
  };
  let before;

  beforeAll(async () => {
    before = env.platformAdminEmails;
    env.platformAdminEmails = [ADMIN];
    admin = await login(ADMIN, { name: 'Boss' });
    stranger = await login('just-a-customer@example.com');
  });
  afterAll(() => {
    env.platformAdminEmails = before;
  });

  it('opens only for a listed email with the authenticator app, after a code on that login', async () => {
    // Not listed: no such page.
    expect((await get(stranger, '/status')).body.data).toEqual({ admin: false });
    expect((await get(stranger, '/overview')).status).toBe(404);
    expect((await api().get('/api/v1/auth/me').set(bearer(stranger.token))).body.data.platformAdmin).toBe(false);
    expect((await api().get('/api/v1/auth/me').set(bearer(admin.token))).body.data.platformAdmin).toBe(true);

    // Listed, but no authenticator app yet.
    expect((await get(admin, '/status')).body.data).toEqual({ admin: true, authenticator: false, unlockedUntil: null });
    expect((await get(admin, '/overview')).body.code).toBe('PLATFORM_NEEDS_AUTHENTICATOR');
    expect((await post(admin, '/unlock', { code: '123456' })).body.code).toBe('PLATFORM_NEEDS_AUTHENTICATOR');

    const setup = (await api().post('/api/v1/auth/totp/setup').set(bearer(admin.token))).body.data;
    secret = setup.secret.replace(/\s/g, '');
    expect((await api().post('/api/v1/auth/totp/enable').set(bearer(admin.token)).send({ code: codeAt(secret) })).status).toBe(200);
    expect((await get(admin, '/overview')).body.code).toBe('PLATFORM_CODE_REQUIRED');

    expect((await post(admin, '/unlock', { code: '000000' })).body.code).toBe('TOTP_WRONG_CODE');
    const open = await post(admin, '/unlock', { code: await freshCode() });
    expect(open.status).toBe(200);
    const until = new Date(open.body.data.unlockedUntil).getTime();
    expect(until).toBeGreaterThan(Date.now() + 29 * 60 * 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000);
    expect((await get(admin, '/overview')).status).toBe(200);
    expect(await AuditLog.exists({ action: 'platform.unlocked', organizationId: admin.data.organizationId })).toBeTruthy();

    // Another login of the same person (Google, then the app) needs its own code; locking closes this one.
    const first = (await api().post('/api/v1/auth/google').send({ credential: `test:sub-${ADMIN}:${ADMIN}:Boss` })).body.data;
    expect(first.step).toBe('authenticator');
    const elsewhere = { token: (await api().post('/api/v1/auth/login/app').send({ challenge: first.challenge, code: await freshCode() })).body.data.token };
    expect((await get(elsewhere, '/overview')).body.code).toBe('PLATFORM_CODE_REQUIRED');
    expect((await post(admin, '/lock')).body.data).toEqual({ unlockedUntil: null });
    expect((await get(admin, '/overview')).body.code).toBe('PLATFORM_CODE_REQUIRED');
    expect((await post(admin, '/unlock', { code: await freshCode() })).status).toBe(200);
  });

  describe('with companies', () => {
    let paying;
    let dueCo;
    let lapsed;
    let stopped;
    beforeAll(async () => {
      const now = Date.now();
      paying = await companyNamed('paying-owner@example.com', 'Paying Traders', { plan: 'growth', subscription: { status: 'active', currentPeriodEnd: new Date(now + 20 * DAY), since: new Date(now - 40 * DAY) } });
      dueCo = await companyNamed('due-owner@example.com', 'Due Spices', { plan: 'pro', subscription: { status: 'past_due', currentPeriodEnd: new Date(now + 2 * DAY), since: new Date(now - DAY) } });
      lapsed = await companyNamed('lapsed-owner@example.com', 'Lapsed Kirana', { plan: 'growth', subscription: { status: 'trialing', trialEndsAt: new Date(now - 2 * DAY) } });
      stopped = await companyNamed('stopped-owner@example.com', 'Stopped Mills', { plan: 'starter', subscription: { status: 'halted', since: new Date(now - 10 * DAY) } });
      await companyNamed('free-owner@example.com', 'Free Friends', { subscription: { status: 'comped', since: new Date(now - 5 * DAY) } });
      const invoice = (who, totalPaise, issuedAt) => BillingInvoice.create({
        organizationId: who.data.organizationId, number: `YC/26-27/${String(Math.random()).slice(2, 8)}`, issuedAt, planKey: 'growth', planName: 'Growth',
        seller: { name: 'Platform' }, buyer: { name: 'Buyer' }, taxablePaise: Math.round(totalPaise / 1.18), igstPaise: totalPaise - Math.round(totalPaise / 1.18), cgstPaise: 0, sgstPaise: 0,
        totalPaise, provider: 'mock', providerPaymentId: `pay_${Math.random()}`,
      });
      await invoice(paying, 589882, new Date());
      await invoice(dueCo, 294882, new Date(now - 35 * DAY));
      await invoice(stopped, 94282, new Date(now - 40 * DAY));

      // Paying Traders: a teammate, a WhatsApp number, two customers and a broadcast this month.
      await inviteAndJoin(paying.token, 'paying-agent@example.com', { role: 'agent', modules: ['inbox'] });
      await api().post('/api/v1/whatsapp/accounts').set(bearer(paying.token)).send({ provider: 'mock' });
      await Contact.create([{ organizationId: paying.data.organizationId, name: 'Secret Customer One' }, { organizationId: paying.data.organizationId, name: 'Secret Customer Two' }]);
      await Broadcast.create({ organizationId: paying.data.organizationId, name: 'Diwali offer', templateId: new mongoose.Types.ObjectId(), segmentId: new mongoose.Types.ObjectId(), startedAt: new Date() });
    });

    it('shows the money: MRR, money in this month, new companies, trial to paid and churn', async () => {
      const o = (await get(admin, '/overview')).body.data;
      // Growth (₹3,999) + Pro (₹1,999), before GST: the paying and payment-due companies (D125).
      expect(o.mrrPaise).toBe(399900 + 199900);
      expect(o.companies).toEqual(expect.objectContaining({ paying: 2, pastDue: 1, comped: 1, locked: 2 }));
      expect(o.collectedThisMonth).toEqual(expect.objectContaining({ totalPaise: 589882, invoices: 1 }));
      // Trials over in the last 90 days (comped left out): Paying, Due, Lapsed, Stopped; three paid.
      expect(o.trialToPaid).toEqual({ finished: 4, paid: 3, pct: 75 });
      // Stopped Mills paid before and stopped 10 days ago: 1 of 3 (2 paying now + 1).
      expect(o.churn).toEqual({ stopped: 1, base: 3, pct: 33.3 });
      expect(o.emails).toEqual(expect.objectContaining({ enabled: false }));
    });

    it('lists every company as counts, with WhatsApp health and filters — never its customers', async () => {
      const res = await get(admin, '/companies?q=Paying');
      expect(res.body.data.total).toBe(1);
      const [row] = res.body.data.items;
      expect(row).toEqual(expect.objectContaining({
        name: 'Paying Traders', plan: 'growth', planName: 'Growth', status: 'active', users: 2, contacts: 2, broadcastsThisMonth: 1,
        owner: { name: expect.any(String), email: 'paying-owner@example.com' },
        paid: { invoices: 1, totalPaise: 589882, lastPaidAt: expect.any(String) },
      }));
      expect(row.whatsapp).toEqual(expect.objectContaining({ numbers: 1, health: expect.stringMatching(/^(ok|warning|error)$/) }));
      expect(JSON.stringify(res.body)).not.toMatch(/Secret Customer/);

      const names = async (status) => (await get(admin, `/companies?status=${status}`)).body.data.items.map((c) => c.name).sort();
      expect(await names('paying')).toEqual(['Due Spices', 'Paying Traders']);
      expect(await names('past_due')).toEqual(['Due Spices']);
      expect(await names('locked')).toEqual(['Lapsed Kirana', 'Stopped Mills']);
      expect(await names('comped')).toEqual(['Free Friends']);
      expect((await get(admin, '/companies?status=everyone')).status).toBe(400);
      // By id too.
      expect((await get(admin, `/companies?q=${lapsed.data.organizationId}`)).body.data.items.map((c) => c.name)).toEqual(['Lapsed Kirana']);
    });

    it('gives a trial, changes the plan or comps a company — written to that company\'s audit log', async () => {
      const act = (body) => post(admin, `/companies/${lapsed.data.organizationId}/actions`, body);
      const trial = await act({ action: 'trial', days: 10 });
      expect(trial.status).toBe(200);
      expect(trial.body.data).toEqual(expect.objectContaining({ name: 'Lapsed Kirana', status: 'trialing', daysLeft: 10, locked: false }));
      expect((await act({ action: 'plan', plan: 'scale' })).body.data).toEqual(expect.objectContaining({ plan: 'scale', planName: 'Scale' }));
      expect((await act({ action: 'comp' })).body.data.status).toBe('comped');

      const entries = await AuditLog.find({ organizationId: lapsed.data.organizationId, action: /^platform\./ }).sort({ createdAt: 1 });
      expect(entries.map((e) => e.action)).toEqual(['platform.trial', 'platform.plan', 'platform.comp']);
      expect(entries[0].changes).toEqual(expect.objectContaining({ days: 10, by: ADMIN, before: { plan: 'growth', status: 'expired' } }));

      expect((await act({ action: 'plan', plan: 'gold' })).status).toBe(400);
      expect((await act({ action: 'trial', days: 0 })).status).toBe(400);
      expect((await act({ action: 'comp', days: 5 })).status).toBe(400);
      expect((await post(admin, `/companies/${new mongoose.Types.ObjectId()}/actions`, { action: 'comp' })).status).toBe(404);
      expect((await post(stranger, `/companies/${lapsed.data.organizationId}/actions`, { action: 'comp' })).status).toBe(404);
    });

    it('shows the go-live checklist and the emails without any key\'s value', async () => {
      const res = await get(admin, '/checklist');
      expect(res.status).toBe(200);
      const byKey = Object.fromEntries(res.body.data.items.map((item) => [item.key, item]));
      expect(byKey.admins.done).toBe(true);
      expect(byKey.email.done).toBe(false);
      expect(byKey.database.done).toBeNull();
      for (const item of res.body.data.items) expect(item).toEqual({ key: expect.any(String), title: expect.any(String), done: item.done, guide: expect.stringMatching(/^docs\//), without: expect.any(String) });
      const text = JSON.stringify(res.body);
      for (const value of [env.jwtSecret, env.googleClientId, env.mongoUri, env.gmailTokenEncryptionKey]) expect(text).not.toContain(value);

      const emails = (await get(admin, '/emails')).body.data;
      expect(emails).toEqual(expect.objectContaining({ enabled: false, totals: expect.objectContaining({ sent: 0 }), recent: expect.any(Array) }));
    });
  });
});
