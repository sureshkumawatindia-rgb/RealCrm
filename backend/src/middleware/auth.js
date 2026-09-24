const { OAuth2Client } = require('google-auth-library');
const env = require('../config/env');
const User = require('../models/User');
const { verifyAppToken } = require('../utils/jwt');

const googleClient = new OAuth2Client(env.googleClientId);

// Used ONLY during login (POST /auth/google), to verify the one-time Google credential.
async function verifyGoogleToken(token) {
  const ticket = await googleClient.verifyIdToken({ idToken: token, audience: env.googleClientId });
  return ticket.getPayload();
}

// Used on every authenticated request. Verifies OUR OWN long-lived JWT (no network call
// to Google, no 1-hour Google ID token expiry breaking the app mid-session).
async function authenticate(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      const error = new Error('Authentication required');
      error.statusCode = 401;
      error.code = 'UNAUTHENTICATED';
      throw error;
    }

    const payload = verifyAppToken(token);
    const user = await User.findOne({ googleId: payload.sub });
    if (!user) {
      const error = new Error('Authenticated user is not registered');
      error.statusCode = 401;
      error.code = 'USER_NOT_REGISTERED';
      throw error;
    }
    req.user = user;
    next();
  } catch (error) {
    if (!error.statusCode) {
      error.statusCode = 401;
      error.code = 'INVALID_AUTHENTICATION';
      error.message = 'Invalid or expired authentication token';
    }
    next(error);
  }
}

module.exports = { authenticate, verifyGoogleToken };