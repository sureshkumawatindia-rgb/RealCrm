jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const User = require('../models/User');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Invite = require('../models/Invite');
const env = require('../config/env');
const migration = require('../migrations/006-organization-slugs');
const { codeFor } = require('../services/otpService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// The login page asks for the company first (D66): its workspace code or its exact name is
// checked before Google, and after Google only that company's team gets in. Nobody gets a new
// company that way; new companies sign up through the separate link (no workspace sent).
const lookup = (company) => api().post('/api/v1/auth/workspace').send({ company });
const google = (email, workspace, extra = {}) => api().post('/api/v1/auth/google')
  .send({ credential: `test:sub-${email}:${email}:${email.split('@')[0]}`, workspace, ...extra });

async function companyOf(email, name) {
  const owner = await login(email);
  const res = await api().patch('/api/v1/organization').set(bearer(owner.token)).send({ name });
  expect(res.status).toBe(200);
  return { ...owner, organization: res.body.data };
}

describe('Workspace codes', () => {
  it('a new company gets a code from its name, the next one with that name a number', async () => {
    const first = await Organization.create({ name: 'Sharma Traders' });
    const second = await Organization.create({ name: '  sharma   traders ' });
    const hindi = await Organization.create({ name: 'शर्मा ट्रेडर्स' });
    expect(first.slug).toBe('sharma-traders');
    expect(second.slug).toBe('sharma-traders-2');
    expect(hindi.slug).toMatch(/^company(-\d+)?$/);
  });

  it('a code made from the name follows a new name; a chosen code stays', async () => {
    const { token, organization } = await companyOf('rename@example.com', 'Verma Electricals');
    expect(organization.slug).toBe('verma-electricals');
    const renamed = await api().patch('/api/v1/organization').set(bearer(token)).send({ name: 'Verma Electricals & Sons' });
    expect(renamed.body.data.slug).toBe('verma-electricals-and-sons');

    const chosen = await api().patch('/api/v1/organization').set(bearer(token)).send({ slug: ' VERMA ' });
    expect(chosen.status).toBe(200);
    expect(chosen.body.data.slug).toBe('verma');
    const again = await api().patch('/api/v1/organization').set(bearer(token)).send({ name: 'Verma Group' });
    expect(again.body.data.slug).toBe('verma');
    expect((await api().get('/api/v1/organization').set(bearer(token))).body.data.slug).toBe('verma');
  });

  it('refuses a taken or badly formed code, and only owners and admins change it', async () => {
    const { token } = await companyOf('codes@example.com', 'Code Owner Co');
    const taken = await api().patch('/api/v1/organization').set(bearer(token)).send({ slug: 'sharma-traders' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('WORKSPACE_CODE_TAKEN');
    for (const bad of ['a', 'two words', '-dash', 'dash-', 'a--b', 'x'.repeat(41), 'नाम']) {
      const res = await api().patch('/api/v1/organization').set(bearer(token)).send({ slug: bad });
      expect(res.status).toBe(400);
    }
    const agent = await inviteAndJoin(token, 'code-agent@example.com');
    expect((await api().patch('/api/v1/organization').set(bearer(agent.token)).send({ slug: 'mine' })).status).toBe(403);
  });
});

describe('POST /auth/workspace', () => {
  it('finds a company by its code or its exact name, ignoring letter case and spaces', async () => {
    await Organization.create({ name: 'Gupta Hardware', logoUrl: 'http://127.0.0.1:3000/uploads/gupta.png' });
    for (const typed of ['gupta-hardware', 'GUPTA-HARDWARE', 'Gupta Hardware', '  gupta   HARDWARE  ']) {
      const res = await lookup(typed);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ name: 'Gupta Hardware', logoUrl: 'http://127.0.0.1:3000/uploads/gupta.png', slug: 'gupta-hardware' });
    }
  });

  it('answers only exact matches, never part of a name', async () => {
    for (const typed of ['Gupta', 'Gupta Hardware Pvt Ltd', 'gupta-hard', 'Gupta.Hardware', '.*']) {
      const res = await lookup(typed);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'WORKSPACE_NOT_FOUND', message: "We couldn't find this company. Check the name or ask your admin." });
    }
    expect((await lookup('')).status).toBe(400);
  });

  it('asks for the code when two companies have the same name', async () => {
    await Organization.create({ name: 'Jain Stores' });
    await Organization.create({ name: 'JAIN STORES' });
    const res = await lookup('jain stores');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WORKSPACE_AMBIGUOUS');
    expect((await lookup('jain-stores-2')).body.data.name).toBe('JAIN STORES');
  });
});

describe('Google login with a company', () => {
  it('signs a member into that company, even when another one was used last', async () => {
    const { token, organization } = await companyOf('boss@example.com', 'Kapoor Textiles');
    const own = await login('both@example.com'); // their own company
    const joined = await inviteAndJoin(token, 'both@example.com');
    // The last one used is their own company again.
    const switched = await api().post('/api/v1/auth/switch-organization').set(bearer(joined.token)).send({ organizationId: own.data.organizationId });
    expect(switched.status).toBe(200);

    const res = await google('both@example.com', 'kapoor-textiles');
    expect(res.status).toBe(200);
    expect(String(res.body.data.organizationId)).toBe(String(organization.id));
    expect(res.body.data.member.role).toBe('agent');
  });

  it('refuses a stranger without making an account or a company', async () => {
    const users = await User.countDocuments();
    const organizations = await Organization.countDocuments();
    const res = await google('stranger@example.com', 'kapoor-textiles');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'NOT_IN_WORKSPACE', message: "This Google account hasn't been added to Kapoor Textiles. Ask your admin to add you." });
    expect(await User.countDocuments()).toBe(users);
    expect(await Organization.countDocuments()).toBe(organizations);
  });

  it('refuses someone with their own company, and a removed member', async () => {
    const outsider = await login('outsider@example.com');
    const organizations = await Organization.countDocuments();
    expect((await google('outsider@example.com', 'kapoor-textiles')).body.code).toBe('NOT_IN_WORKSPACE');
    expect(await Organization.countDocuments()).toBe(organizations);
    expect(String((await User.findOne({ email: 'outsider@example.com' })).organizationId)).toBe(String(outsider.data.organizationId));

    const boss = await login('boss@example.com');
    const left = await inviteAndJoin(boss.token, 'left@example.com');
    await OrganizationMember.updateOne({ _id: left.data.member.id }, { status: 'disabled' });
    expect((await google('left@example.com', 'kapoor-textiles')).body.code).toBe('NOT_IN_WORKSPACE');
  });

  it('lets in someone the company invited, with or without the link', async () => {
    const boss = await login('boss@example.com');
    await api().post('/api/v1/invites').set(bearer(boss.token)).send({ email: 'new-hire@example.com', role: 'agent' });
    const res = await google('new-hire@example.com', 'kapoor-textiles');
    expect(res.status).toBe(200);
    expect(res.body.data.member.role).toBe('agent');
    expect(await Invite.exists({ email: 'new-hire@example.com', status: 'accepted' })).toBeTruthy();

    // The invite link fills in the company on the login card.
    const invite = await api().post('/api/v1/invites').set(bearer(boss.token)).send({ email: 'linked@example.com', role: 'viewer' });
    const inviteToken = new URL(invite.body.data.link).searchParams.get('invite');
    expect((await api().post('/api/v1/invites/lookup').send({ token: inviteToken })).body.data).toMatchObject({ organizationName: 'Kapoor Textiles', workspace: 'kapoor-textiles' });
    expect((await google('linked@example.com', 'kapoor-textiles', { inviteToken })).body.data.member.role).toBe('viewer');
  });

  it('refuses a code that is not a company, and keeps the sign-up flow for new companies', async () => {
    expect((await google('boss@example.com', 'no-such-company')).body.code).toBe('WORKSPACE_NOT_FOUND');
    const signup = await google('founder@example.com', '');
    expect(signup.status).toBe(200);
    expect(signup.body.data.member.role).toBe('owner');
  });
});

describe('Google login with a company and the WhatsApp code', () => {
  let boss;
  beforeAll(async () => {
    boss = await companyOf('two-step-boss@example.com', 'Mehta Pharma');
    await api().post('/api/v1/invites').set(bearer(boss.token)).send({ email: 'two-step-agent@example.com', role: 'agent' });
    env.login.whatsappCode = 'required';
  });
  afterAll(() => {
    env.login.whatsappCode = 'off';
  });

  it('carries the company to the code step and checks the team again there', async () => {
    const first = await google('two-step-agent@example.com', 'mehta-pharma');
    expect(first.body.data.step).toBe('whatsapp-code');
    const { challenge } = first.body.data;
    await api().post('/api/v1/auth/login/code').send({ challenge, phone: '98290 44444' });
    const done = await api().post('/api/v1/auth/login/verify').send({ challenge, phone: '9829044444', code: codeFor('+919829044444') });
    expect(done.status).toBe(200);
    expect(String(done.body.data.organizationId)).toBe(String(boss.organization.id));

    // Removed while typing the code: refused at the end, and no company made for them.
    const next = (await google('two-step-agent@example.com', 'mehta-pharma')).body.data;
    await OrganizationMember.updateOne({ _id: done.body.data.member.id }, { status: 'disabled' });
    await api().post('/api/v1/auth/login/code').send({ challenge: next.challenge, phone: '9829044444' });
    const organizations = await Organization.countDocuments();
    const refused = await api().post('/api/v1/auth/login/verify').send({ challenge: next.challenge, phone: '9829044444', code: codeFor('+919829044444') });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('NOT_IN_WORKSPACE');
    expect(await Organization.countDocuments()).toBe(organizations);
  });
});

describe('Migration 006', () => {
  it('gives every company without a code one from its name, oldest first, once', async () => {
    const older = new Date('2024-01-01');
    const newer = new Date('2024-06-01');
    const { insertedIds } = await Organization.collection.insertMany([
      { name: 'Old Joshi Motors', createdAt: newer },
      { name: 'old joshi motors', createdAt: older },
      { name: 'Already Coded', slug: 'my-own-code', createdAt: older },
    ]);
    const result = await migration.up();
    expect(result.updated).toBe(2); // every other company got its code when it was made
    const slugOf = async (id) => (await Organization.collection.findOne({ _id: id })).slug;
    expect(await slugOf(insertedIds[1])).toBe('old-joshi-motors');
    expect(await slugOf(insertedIds[0])).toBe('old-joshi-motors-2');
    expect(await slugOf(insertedIds[2])).toBe('my-own-code');
    expect((await migration.up()).updated).toBe(0);
    expect(await Organization.collection.countDocuments({ slug: { $not: { $type: 'string' } } })).toBe(0);
  });
});

describe('Rate limit', () => {
  it('stops one address guessing company names', async () => {
    const statuses = [];
    for (let i = 0; i < env.rateLimit.workspacePerMinute + 1; i += 1) statuses.push((await lookup(`guess ${i}`)).status);
    expect(statuses).toContain(429);
  });
});
