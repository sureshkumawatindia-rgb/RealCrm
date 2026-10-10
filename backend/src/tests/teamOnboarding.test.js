jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const AuditLog = require('../models/AuditLog');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// "Invite your team" after sign-up (D64): once, for a company with nobody else in it yet; done or
// skipped, it never comes back.
const onboarding = async (token) => api().get('/api/v1/organization/onboarding').set(bearer(token));

describe('Invite your team step', () => {
  it('comes once for a new company, and goes for good when skipped', async () => {
    const owner = await login('onboard-skip@example.com');
    expect((await onboarding(owner.token)).body.data).toEqual({ teamStep: true });
    const skipped = await api().post('/api/v1/organization/onboarding/team').set(bearer(owner.token)).send({ skipped: true });
    expect(skipped.body.data).toEqual({ teamStep: false });
    expect((await onboarding(owner.token)).body.data).toEqual({ teamStep: false });
    expect(await AuditLog.countDocuments({ action: 'onboarding.team_skipped' })).toBe(1);
    // Twice is still once.
    await api().post('/api/v1/organization/onboarding/team').set(bearer(owner.token)).send({ skipped: true });
    expect(await AuditLog.countDocuments({ action: 'onboarding.team_skipped' })).toBe(1);
  });

  it('never shows for a company that already invited someone; only owners and admins ask', async () => {
    const owner = await login('onboard-invited@example.com');
    const agent = await inviteAndJoin(owner.token, 'onboard-agent@example.com', { role: 'agent' });
    expect((await onboarding(owner.token)).body.data).toEqual({ teamStep: false });
    expect((await onboarding(agent.token)).status).toBe(403);
    expect((await api().post('/api/v1/organization/onboarding/team').set(bearer(agent.token)).send({})).status).toBe(403);
  });

  it('sending invites from the step uses the same seat limit as Settings', async () => {
    const owner = await login('onboard-send@example.com');
    const res = await api().post('/api/v1/invites').set(bearer(owner.token)).send({ email: 'helper@example.com', role: 'agent', modules: ['inbox', 'leads'] });
    expect(res.status).toBe(201);
    expect(res.body.data.link).toMatch(/invite=/);
    expect((await onboarding(owner.token)).body.data).toEqual({ teamStep: false });
  });
});
