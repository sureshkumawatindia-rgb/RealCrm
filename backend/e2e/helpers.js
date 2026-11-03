// Helpers of the end-to-end tests (Phase 2, D114).

// Signs a person in with the test Google sign-in (the e2e server's fake verifier), as the login
// page would after Google's button: through the browser context's own requests (so the refresh
// cookie lands in the browser), and the session in the browser's storage before any page of this
// context loads (a session the app renewed meanwhile is kept). → { token, user, member }.
async function signIn(context, { email, name, inviteToken }) {
  const res = await context.request.post('/api/v1/auth/google', { data: { credential: `test:e2e-${email}:${email}:${name}`, ...(inviteToken && { inviteToken }) } });
  if (!res.ok()) throw new Error(`Sign-in of ${email} failed: ${res.status()} ${await res.text()}`);
  const { token, user, member } = (await res.json()).data;
  await context.addInitScript(({ session, userJson, memberJson }) => {
    if (window.location.pathname.startsWith('/crm/frontend') && !window.localStorage.getItem('crm_session')) {
      window.localStorage.setItem('crm_session', session);
      window.localStorage.setItem('crm_user', userJson);
      window.localStorage.setItem('crm_member', memberJson);
    }
  }, { session: token, userJson: JSON.stringify(user), memberJson: JSON.stringify(member) });
  return { token, user, member };
}

// A call to the API as a signed-in person (for setting up what a flow does not test itself).
async function api(context, token, method, path, data) {
  const res = await context.request.fetch(`/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}` }, ...(data !== undefined && { data }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${JSON.stringify(body)}`);
  return body.data;
}

// The CRM's pages live under /crm/frontend.
const page = (name) => `/crm/frontend/${name}`;

module.exports = { signIn, api, page };
