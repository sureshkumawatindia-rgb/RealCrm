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

// Signs in a new company on the Scale plan (still on its trial): the public API and webhooks come
// with Scale and above since D125, and the tests of the API need them. Someone joining an
// existing company (inviteToken) leaves its plan as it is.
async function loginWithApi(email, options = {}) {
  const user = await login(email, options);
  if (!options.inviteToken) {
    const Organization = require('../../models/Organization'); // eslint-disable-line global-require
    await Organization.updateOne({ _id: user.data.organizationId }, { $set: { plan: 'scale' } });
  }
  return user;
}

module.exports = { api, bearer, login, loginWithApi, inviteAndJoin, cookieValue };
