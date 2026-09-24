const jwt = require('jsonwebtoken');
const env = require('../config/env');

function signAppToken(user) {
  if (!env.jwtSecret) {
    const error = new Error('JWT_SECRET is not configured on the server');
    error.statusCode = 500;
    error.code = 'JWT_SECRET_MISSING';
    throw error;
  }
  return jwt.sign(
    { sub: user.googleId, uid: String(user._id) },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn },
  );
}

function verifyAppToken(token) {
  if (!env.jwtSecret) {
    const error = new Error('JWT_SECRET is not configured on the server');
    error.statusCode = 500;
    error.code = 'JWT_SECRET_MISSING';
    throw error;
  }
  return jwt.verify(token, env.jwtSecret);
}

module.exports = { signAppToken, verifyAppToken };