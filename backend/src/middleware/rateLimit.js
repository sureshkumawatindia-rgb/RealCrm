const { rateLimit } = require('express-rate-limit');
const env = require('../config/env');
const httpError = require('../utils/httpError');

function perMinute(limit, options = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res, next) => next(httpError(429, 'RATE_LIMITED', 'Too many requests. Please wait a minute and try again.')),
    ...options,
  });
}

// The launcher polls /health while the server starts, so it is not counted.
const apiLimiter = perMinute(env.rateLimit.apiPerMinute, { skip: (req) => req.path === '/health' });
const authLimiter = perMinute(env.rateLimit.authPerMinute);

module.exports = { apiLimiter, authLimiter };
