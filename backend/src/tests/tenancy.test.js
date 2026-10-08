jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Organization = require('../models/Organization');
const Invite = require('../models/Invite');
const { can, canViewAll } = require('../constants/permissions');
const { api, bearer, login, inviteAndJoin, cookieValue } = require('./helpers/api');

describe('Tenant isolation', () => {
  let ownerA;
  let ownerB;

  beforeAll(async () => {
    ownerA = await login('owner-a@example.com', { name: 'Anil' });
    ownerB = await login('owner-b@example.com', { name: 'Bina' });
  });

  it('each owner reads and updates only their own organization', async () => {
    await api().patch('/api/v1/organization').set(bearer(ownerA.token)).send({ name: 'Alpha Traders', city: 'Jaipur' });

    const a = await api().get('/api/v1/organization').set(bearer(ownerA.token));
    const b = await api().get('/api/v1/organization').set(bearer(ownerB.token));
    expect(a.body.data.name).toBe('Alpha Traders');
    expect(b.body.data.name).toBe('Bina Organization');
    expect(b.body.data.city).toBe('');
  });

  it('member lists never include another organization', async () => {
    await inviteAndJoin(ownerA.token, 'agent-a@example.com');
    const a = await api().get('/api/v1/members').set(bearer(ownerA.token));
    const b = await api().get('/api/v1/members').set(bearer(ownerB.token));
    expect(a.body.data.map((m) => m.email).sort()).toEqual(['agent-a@example.com', 'owner-a@example.com']);
    expect(b.body.data.map((m) => m.email)).toEqual(['owner-b@example.com']);
    expect(a.body.pagination).toMatchObject({ page: 1, total: 2 });
  });

  it("another organization's members and invites look like they do not exist", async () => {
    const aMembers = await api().get('/api/v1/members').set(bearer(ownerA.token));
    const agentId = aMembers.body.data.find((m) => m.email === 'agent-a@example.com').id;

    const patch = await api().patch(`/api/v1/members/${agentId}`).set(bearer(ownerB.token)).send({ role: 'viewer' });
    expect(patch.status).toBe(404);
    const remove = await api().delete(`/api/v1/members/${agentId}`).set(bearer(ownerB.token));
    expect(remove.status).toBe(404);

    const invite = await api().post('/api/v1/invites').set(bearer(ownerA.token)).send({ email: 'later@example.com', role: 'viewer' });
    const revoke = await api().delete(`/api/v1/invites/${invite.body.data.invite.id}`).set(bearer(ownerB.token));
    expect(revoke.status).toBe(404);
  });

  it('an invited user joins the inviting organization without getting their own', async () => {
    const before = await Organization.countDocuments();
    const joined = await inviteAndJoin(ownerA.token, 'agent-two@example.com');
    expect(await Organization.countDocuments()).toBe(before);
    expect(String(joined.data.organizationId)).toBe(String(ownerA.data.organizationId));
    expect(joined.data.member.role).toBe('agent');
    expect(joined.data.member.modules).toContain('leads');
  });
});

describe('Roles and permissions', () => {
  let owner;
  let agent;
  let viewer;
  let admin;

  beforeAll(async () => {
    owner = await login('rbac-owner@example.com');
    agent = await inviteAndJoin(owner.token, 'rbac-agent@example.com', { role: 'agent' });
    viewer = await inviteAndJoin(owner.token, 'rbac-viewer@example.com', { role: 'viewer' });
    admin = await inviteAndJoin(owner.token, 'rbac-admin@example.com', { role: 'admin' });
  });

  it('agents and viewers can read the company profile and team but not change them', async () => {
    for (const { token } of [agent, viewer]) {
      expect((await api().get('/api/v1/organization').set(bearer(token))).status).toBe(200);
      expect((await api().get('/api/v1/members').set(bearer(token))).status).toBe(200);
      const patch = await api().patch('/api/v1/organization').set(bearer(token)).send({ name: 'Hacked' });
      expect(patch.status).toBe(403);
      expect(patch.body.code).toBe('FORBIDDEN');
      expect((await api().post('/api/v1/invites').set(bearer(token)).send({ email: 'x@example.com', role: 'agent' })).status).toBe(403);
      expect((await api().get('/api/v1/invites').set(bearer(token))).status).toBe(403);
    }
  });

  it('admins manage agents but not owners or other admins', async () => {
    const members = (await api().get('/api/v1/members').set(bearer(owner.token))).body.data;
    const id = (email) => members.find((m) => m.email === email).id;

    const toViewer = await api().patch(`/api/v1/members/${id('rbac-agent@example.com')}`).set(bearer(admin.token)).send({ modules: ['leads', 'tasks'] });
    expect(toViewer.status).toBe(200);
    expect(toViewer.body.data.modules).toEqual(['leads', 'tasks']);

    const promote = await api().patch(`/api/v1/members/${id('rbac-agent@example.com')}`).set(bearer(admin.token)).send({ role: 'admin' });
    expect(promote.status).toBe(403);
    const touchOwner = await api().patch(`/api/v1/members/${id('rbac-owner@example.com')}`).set(bearer(admin.token)).send({ modules: [] });
    expect(touchOwner.status).toBe(403);
    const inviteAdmin = await api().post('/api/v1/invites').set(bearer(admin.token)).send({ email: 'new-admin@example.com', role: 'admin' });
    expect(inviteAdmin.status).toBe(403);
  });

  it('protects the last owner and stops self-demotion', async () => {
    const members = (await api().get('/api/v1/members').set(bearer(owner.token))).body.data;
    const ownerId = members.find((m) => m.email === 'rbac-owner@example.com').id;
    const self = await api().patch(`/api/v1/members/${ownerId}`).set(bearer(owner.token)).send({ role: 'admin' });
    expect(self.status).toBe(403);
    const removeSelf = await api().delete(`/api/v1/members/${ownerId}`).set(bearer(owner.token));
    expect(removeSelf.status).toBe(403);
  });

  it('rejects unknown modules and permissions', async () => {
    const members = (await api().get('/api/v1/members').set(bearer(owner.token))).body.data;
    const agentId = members.find((m) => m.email === 'rbac-agent@example.com').id;
    const res = await api().patch(`/api/v1/members/${agentId}`).set(bearer(owner.token)).send({ modules: ['billing'], permissions: ['leads:everything'] });
    expect(res.status).toBe(400);
    expect(res.body.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['modules.0', 'permissions.0']));
  });

  it('a removed member loses access immediately and cannot refresh', async () => {
    const removed = await inviteAndJoin(owner.token, 'rbac-removed@example.com');
    const members = (await api().get('/api/v1/members').set(bearer(owner.token))).body.data;
    const removedId = members.find((m) => m.email === 'rbac-removed@example.com').id;

    expect((await api().delete(`/api/v1/members/${removedId}`).set(bearer(owner.token))).status).toBe(200);
    const me = await api().get('/api/v1/auth/me').set(bearer(removed.token));
    expect(me.status).toBe(401);
    expect(me.body.code).toBe('MEMBERSHIP_REVOKED');
    const refresh = await api().post('/api/v1/auth/refresh').set('Cookie', cookieValue(removed.cookie));
    expect(refresh.status).toBe(401);
  });

  it('can() follows the role rules', () => {
    const agentMember = { role: 'agent', status: 'active', modules: ['leads'], permissions: ['leads:view_all'] };
    const viewerMember = { role: 'viewer', status: 'active', modules: ['leads'], permissions: [] };
    expect(can(agentMember, 'leads', 'edit')).toBe(true);
    expect(can(agentMember, 'leads', 'delete')).toBe(false);
    expect(can(agentMember, 'deals', 'view')).toBe(false);
    expect(can(viewerMember, 'leads', 'view')).toBe(true);
    expect(can(viewerMember, 'leads', 'create')).toBe(false);
    expect(can({ role: 'admin', status: 'active', modules: [] }, 'settings', 'delete')).toBe(true);
    expect(can({ ...agentMember, status: 'disabled' }, 'leads', 'view')).toBe(false);
    expect(canViewAll(agentMember, 'leads')).toBe(true);
    expect(canViewAll(viewerMember, 'leads')).toBe(false);
  });
});

describe('Invites and several organizations', () => {
  it('a user who owns an organization can join another and switch between them', async () => {
    const hostOwner = await login('host@example.com', { name: 'Host' });
    const guest = await login('guest@example.com', { name: 'Guest' });

    const joined = await inviteAndJoin(hostOwner.token, 'guest@example.com', { role: 'viewer' });
    expect(joined.data.memberships).toHaveLength(2);
    expect(String(joined.data.organizationId)).toBe(String(hostOwner.data.organizationId));

    const switched = await api().post('/api/v1/auth/switch-organization').set(bearer(joined.token)).send({ organizationId: String(guest.data.organizationId) });
    expect(switched.status).toBe(200);
    const me = await api().get('/api/v1/auth/me').set(bearer(switched.body.data.token));
    expect(me.body.data.organization.name).toBe('Guest Organization');
    expect(me.body.data.member.role).toBe('owner');

    const notMine = await api().post('/api/v1/auth/switch-organization').set(bearer(joined.token)).send({ organizationId: '0123456789abcdef01234567' });
    expect(notMine.status).toBe(403);
  });

  it('a link for another email still logs in, and reports the mismatch', async () => {
    const owner = await login('mismatch-owner@example.com');
    const invite = await api().post('/api/v1/invites').set(bearer(owner.token)).send({ email: 'right@example.com', role: 'agent' });
    const inviteToken = new URL(invite.body.data.link).searchParams.get('invite');

    const wrong = await login('wrong@example.com', { inviteToken });
    expect(wrong.data.inviteError.code).toBe('INVITE_EMAIL_MISMATCH');
    expect(wrong.data.memberships).toHaveLength(1);
  });

  it('invite lookup is public, and revoked links stop working', async () => {
    const owner = await login('lookup-owner@example.com', { name: 'Lookup' });
    const invite = await api().post('/api/v1/invites').set(bearer(owner.token)).send({ email: 'lookup@example.com', role: 'agent' });
    const token = new URL(invite.body.data.link).searchParams.get('invite');

    const found = await api().post('/api/v1/invites/lookup').send({ token });
    expect(found.status).toBe(200);
    expect(found.body.data).toMatchObject({ organizationName: 'Lookup Organization', logoUrl: '', email: 'lookup@example.com', role: 'agent' });

    await api().delete(`/api/v1/invites/${invite.body.data.invite.id}`).set(bearer(owner.token));
    const gone = await api().post('/api/v1/invites/lookup').send({ token });
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('INVITE_INVALID');
  });

  it('inviting an existing member is a conflict', async () => {
    const owner = await login('dup-owner@example.com');
    await inviteAndJoin(owner.token, 'dup-agent@example.com');
    const again = await api().post('/api/v1/invites').set(bearer(owner.token)).send({ email: 'dup-agent@example.com', role: 'agent' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_MEMBER');
  });

  it('Idempotency-Key replays the first response and rejects a different body', async () => {
    const owner = await login('idem-owner@example.com');
    const send = (body) => api().post('/api/v1/invites').set(bearer(owner.token)).set('Idempotency-Key', 'invite-key-0001').send(body);

    const first = await send({ email: 'idem@example.com', role: 'agent' });
    const second = await send({ email: 'idem@example.com', role: 'agent' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.link).toBe(first.body.data.link);
    expect(await Invite.countDocuments({ email: 'idem@example.com' })).toBe(1);

    const different = await send({ email: 'other@example.com', role: 'agent' });
    expect(different.status).toBe(422);
    expect(different.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('an invite carries the name, mobile and title typed by the inviter into the membership', async () => {
    const owner = await login('champ-owner@example.com');
    const invite = await api().post('/api/v1/invites').set(bearer(owner.token)).send({
      email: 'champ@example.com', role: 'agent', modules: ['leads', 'deals'], permissions: ['leads:delete', 'leads:view_all'],
      displayName: 'Rohan Mehta', mobile: '+91 98765 43210', title: 'Sales',
    });
    expect(invite.body.data.invite).toMatchObject({ displayName: 'Rohan Mehta', mobile: '+91 98765 43210', title: 'Sales' });

    await login('champ@example.com', { name: 'rohan.g', inviteToken: new URL(invite.body.data.link).searchParams.get('invite') });
    const members = (await api().get('/api/v1/members').set(bearer(owner.token))).body.data;
    const rohan = members.find((m) => m.email === 'champ@example.com');
    expect(rohan).toMatchObject({ name: 'Rohan Mehta', mobile: '+91 98765 43210', title: 'Sales', role: 'agent', modules: ['leads', 'deals'], permissions: ['leads:delete', 'leads:view_all'] });

    const retitled = await api().patch(`/api/v1/members/${rohan.id}`).set(bearer(owner.token)).send({ title: 'Support', role: 'viewer' });
    expect(retitled.body.data).toMatchObject({ title: 'Support', role: 'viewer' });
    expect((await api().post('/api/v1/invites').set(bearer(owner.token)).send({ email: 'x@example.com', role: 'agent', title: 'x'.repeat(61) })).status).toBe(400);
  });
});
