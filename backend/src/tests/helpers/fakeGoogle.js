// Stand-in for integrations/google/idToken in tests.
// Credential format: "test:<google sub>:<email>[:<name>]". Anything else is rejected like Google would.
async function verifyGoogleIdToken(credential) {
  if (!String(credential).startsWith('test:')) throw new Error('Wrong number of segments in token');
  const [, sub, email, name] = String(credential).split(':');
  return { sub, email, email_verified: true, name: name || email, picture: '' };
}

module.exports = { verifyGoogleIdToken };
