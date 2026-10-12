jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const { api, bearer, inviteAndJoin, login } = require('./helpers/api');

// CP5: each person's language and theme live on their account, the same on every device and in
// every company they belong to.
const signIn = (email, language) => api().post('/api/v1/auth/google').send({ credential: `test:sub-${email}:${email}:${email.split('@')[0]}`, ...(language && { language }) });

describe('Language and theme', () => {
  it("keeps the login page's language for a new person, and never overrides a choice made later", async () => {
    const first = await signIn('hindi-owner@example.com', 'hi');
    expect(first.status).toBe(200);
    expect(first.body.data.user.preferences).toEqual({ language: 'hi', theme: 'system' });

    const token = first.body.data.token;
    expect((await api().patch('/api/v1/auth/preferences').set(bearer(token)).send({ language: 'en' })).body.data).toEqual({ language: 'en', theme: 'system' });
    // A later sign-in from a Hindi login page keeps the person's own choice.
    const again = await signIn('hindi-owner@example.com', 'hi');
    expect(again.body.data.user.preferences.language).toBe('en');
  });

  it('saves the theme and language for the person, shown by /auth/me on any device and company', async () => {
    const owner = await login('theme-owner@example.com');
    expect(owner.data.user.preferences).toEqual({ language: 'en', theme: 'system' });
    const saved = await api().patch('/api/v1/auth/preferences').set(bearer(owner.token)).send({ theme: 'dark', language: 'hi' });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({ language: 'hi', theme: 'dark' });

    const otherDevice = await login('theme-owner@example.com');
    expect(otherDevice.data.user.preferences).toEqual({ language: 'hi', theme: 'dark' });
    expect((await api().get('/api/v1/auth/me').set(bearer(otherDevice.token))).body.data.user.preferences).toEqual({ language: 'hi', theme: 'dark' });

    // Only one's own: a teammate's stays as it was.
    const agent = await inviteAndJoin(owner.token, 'theme-agent@example.com', { role: 'agent' });
    expect((await api().get('/api/v1/auth/me').set(bearer(agent.token))).body.data.user.preferences).toEqual({ language: 'en', theme: 'system' });
  });

  it('refuses unknown values, an empty change and a request without sign-in', async () => {
    const owner = await login('theme-checks@example.com');
    const patch = (body) => api().patch('/api/v1/auth/preferences').set(bearer(owner.token)).send(body);
    expect((await patch({ theme: 'blue' })).status).toBe(400);
    expect((await patch({ language: 'fr' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await signIn('theme-checks@example.com', 'fr')).status).toBe(400);
    expect((await api().patch('/api/v1/auth/preferences').send({ theme: 'dark' })).status).toBe(401);
  });
});
