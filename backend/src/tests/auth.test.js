jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const { api, bearer, login, cookieValue } = require('./helpers/api');

describe('Google login', () => {
  it('creates the user, an organization and an owner membership on first login', async () => {
    const { res, data, cookie } = await login('first@example.com');

    expect(res.status).toBe(200);
    expect(data.token.split('.')).toHaveLength(3);
    expect(data.user.email).toBe('first@example.com');
    expect(data.member.role).toBe('owner');
    expect(data.memberships).toHaveLength(1);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(cookie).toMatch(/SameSite=Strict/);

    const user = await User.findOne({ email: 'first@example.com' });
    const members = await OrganizationMember.find({ userId: user._id });
    expect(members).toHaveLength(1);
    expect(String(members[0].organizationId)).toBe(String(data.organizationId));
  });

  it('does not create a second organization on the next login', async () => {
    await login('again@example.com');
    const before = await Organization.countDocuments();
    await login('again@example.com');
    expect(await Organization.countDocuments()).toBe(before);
  });

  it('adopts the organization of a user who signed up before memberships existed', async () => {
    const user = await User.create({ googleId: 'sub-legacy@example.com', email: 'legacy@example.com', name: 'Legacy' });
    const organization = await Organization.create({ name: 'Legacy Org', ownerId: user._id });
    user.organizationId = organization._id;
    await user.save();

    const { data } = await login('legacy@example.com');
    expect(String(data.organizationId)).toBe(String(organization._id));
    expect(data.member.role).toBe('owner');
    expect(await Organization.countDocuments({ ownerId: user._id })).toBe(1);
  });

  it('rejects a credential Google would reject', async () => {
    const res = await api().post('/api/v1/auth/google').send({ credential: 'not-a-google-token' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_GOOGLE_CREDENTIAL');
  });

  it('requires a credential', async () => {
    const res = await api().post('/api/v1/auth/google').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.errors[0].field).toBe('credential');
  });
});

describe('Access tokens', () => {
  it('GET /auth/me returns the user, organization and membership', async () => {
    const { token } = await login('me@example.com', { name: 'Meera' });
    const res = await api().get('/api/v1/auth/me').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('me@example.com');
    expect(res.body.data.organization.name).toBe('Meera Organization');
    expect(res.body.data.member.role).toBe('owner');
  });

  it('rejects missing, invalid, expired and old-format tokens', async () => {
    const missing = await api().get('/api/v1/auth/me');
    expect(missing.body.code).toBe('UNAUTHENTICATED');

    const garbage = await api().get('/api/v1/auth/me').set(bearer('a.b.c'));
    expect(garbage.body.code).toBe('INVALID_AUTHENTICATION');

    const { data } = await login('expired@example.com');
    const expired = jwt.sign({ org: String(data.organizationId), sid: 'x' }, process.env.JWT_SECRET, {
      subject: 'x', expiresIn: -10, issuer: 'yellow-crm', audience: 'yellow-crm-api',
    });
    const expiredRes = await api().get('/api/v1/auth/me').set(bearer(expired));
    expect(expiredRes.status).toBe(401);
    expect(expiredRes.body.code).toBe('TOKEN_EXPIRED');

    // Tokens from before Phase 1 (sub = Google id, no audience) must not work any more.
    const oldFormat = jwt.sign({ sub: 'sub-expired@example.com', uid: 'x' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const oldRes = await api().get('/api/v1/auth/me').set(bearer(oldFormat));
    expect(oldRes.body.code).toBe('INVALID_AUTHENTICATION');
  });
});

describe('Refresh tokens', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const { cookie } = await login('rotate@example.com');
    const res = await api().post('/api/v1/auth/refresh').set('Cookie', cookieValue(cookie));
    expect(res.status).toBe(200);
    expect(res.body.data.token.split('.')).toHaveLength(3);

    const nextCookie = res.headers['set-cookie'].find((value) => value.startsWith('crm_refresh='));
    expect(cookieValue(nextCookie)).not.toBe(cookieValue(cookie));

    const me = await api().get('/api/v1/auth/me').set(bearer(res.body.data.token));
    expect(me.status).toBe(200);
  });

  it('revokes the whole family when an already-rotated token is used again', async () => {
    const { cookie } = await login('reuse@example.com');
    const first = await api().post('/api/v1/auth/refresh').set('Cookie', cookieValue(cookie));
    const rotatedCookie = first.headers['set-cookie'].find((value) => value.startsWith('crm_refresh='));

    const replay = await api().post('/api/v1/auth/refresh').set('Cookie', cookieValue(cookie));
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('REFRESH_TOKEN_REUSED');

    const afterReuse = await api().post('/api/v1/auth/refresh').set('Cookie', cookieValue(rotatedCookie));
    expect(afterReuse.status).toBe(401);
  });

  it('logout revokes the refresh token and clears the cookie', async () => {
    const { cookie } = await login('logout@example.com');
    const out = await api().post('/api/v1/auth/logout').set('Cookie', cookieValue(cookie));
    expect(out.status).toBe(200);
    expect(out.headers['set-cookie'].join(';')).toMatch(/crm_refresh=;/);

    const res = await api().post('/api/v1/auth/refresh').set('Cookie', cookieValue(cookie));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('refresh without a cookie is rejected', async () => {
    const res = await api().post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
  });
});
