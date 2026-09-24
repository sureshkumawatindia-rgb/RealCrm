const express = require('express');
const User = require('../models/User');
const Organization = require('../models/Organization');
const { verifyGoogleToken } = require('../middleware/auth');
const { signAppToken } = require('../utils/jwt');
const logger = require('../config/logger');

const router = express.Router();

function safeGoogleAuthMessage(error) {
  const message = String(error.message || '');
  if (/token used too early|issued in the future|iat/i.test(message)) {
    return 'Google token rejected because the server clock is not synchronized. Synchronize the server time and try again.';
  }
  if (/expired|exp/i.test(message)) {
    return 'Google token expired. Start Google sign-in again.';
  }
  if (/audience|azp|client/i.test(message)) {
    return 'Google token audience does not match this application. Check the configured Google client ID.';
  }
  if (/issuer|iss/i.test(message)) {
    return 'Google token issuer is not trusted.';
  }
  if (/segment|jwt|token/i.test(message)) {
    return 'Google returned an invalid authentication token.';
  }
  return 'Google authentication failed. Please try again.';
}

router.post('/google', async (req, res, next) => {
  try {
    const credential = req.body?.credential;
    if (!credential) {
      const error = new Error('Google credential is required');
      error.statusCode = 400;
      error.code = 'CREDENTIAL_REQUIRED';
      throw error;
    }

    const payload = await verifyGoogleToken(credential);
    let user = await User.findOne({ googleId: payload.sub });
    if (!user) {
      const organization = await Organization.create({
        name: `${payload.name || payload.email || 'My'} Organization`,
        ownerId: null,
      });
      user = await User.create({
        googleId: payload.sub,
        email: payload.email,
        name: payload.name || payload.email,
        picture: payload.picture || '',
        organizationId: organization._id,
      });
      organization.ownerId = user._id;
      await organization.save();
    } else {
      user.email = payload.email || user.email;
      user.name = payload.name || user.name;
      user.picture = payload.picture || user.picture;
      await user.save();
    }

    const appToken = signAppToken(user);

    res.json({
      success: true,
      data: {
        token: appToken,
        user: {
          id: user.googleId,
          email: user.email,
          name: user.name,
          picture: user.picture,
        },
        organizationId: user.organizationId,
      },
    });
  } catch (error) {
    const googleReason = safeGoogleAuthMessage(error);
    logger.error(`Google login verification failed: ${googleReason}`);
    if (!error.statusCode) {
      error.statusCode = 401;
      error.code = 'INVALID_GOOGLE_CREDENTIAL';
      error.message = googleReason;
    }
    next(error);
  }
});

module.exports = router;