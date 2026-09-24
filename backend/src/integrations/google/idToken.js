const { OAuth2Client } = require('google-auth-library');
const env = require('../../config/env');

const googleClient = new OAuth2Client(env.googleClientId);

// Verifies the one-time Google ID token from Google Sign-In (signature, audience, issuer, expiry).
// Tests replace this module with a mock; nothing else calls Google during login.
async function verifyGoogleIdToken(idToken) {
  const ticket = await googleClient.verifyIdToken({ idToken, audience: env.googleClientId });
  return ticket.getPayload();
}

module.exports = { verifyGoogleIdToken };
