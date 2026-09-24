const request = require('supertest');
const app = require('../../app');

const api = () => request(app);
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// Signs in through POST /auth/google with the fake Google verifier.
async function login(email, { sub = `sub-${email}`, name = email.split('@')[0], inviteToken } = {}) {
  const res = await api().post('/api/v1/auth/google').send({ credential: `test:${sub}:${email}:${name}`, inviteToken });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    res,
    token: res.body.data.token,
    data: res.body.data,
    cookie: (res.headers['set-cookie'] || []).find((value) => value.startsWith('crm_refresh=')),
  };
}

// Owner creates an invite; the invitee signs in with the link token.
async function inviteAndJoin(ownerToken, email, body = {}) {
  const invite = await api().post('/api/v1/invites').set(bearer(ownerToken)).send({ email, role: 'agent', ...body });
  if (invite.status !== 201) throw new Error(`invite failed: ${invite.status} ${JSON.stringify(invite.body)}`);
  const inviteToken = new URL(invite.body.data.link).searchParams.get('invite');
  return login(email, { inviteToken });
}

const cookieValue = (setCookie) => setCookie.split(';')[0];

module.exports = { api, bearer, login, inviteAndJoin, cookieValue };
