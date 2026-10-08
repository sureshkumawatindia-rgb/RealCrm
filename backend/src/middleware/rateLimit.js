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
// Meta sends webhooks in bursts from a few addresses; this only stops floods.
const webhookLimiter = perMinute(env.rateLimit.webhookPerMinute);
// Website enquiry forms: a person sends one or two; more from one address is a bot.
const formLimiter = perMinute(env.rateLimit.formPerMinute);
// Customers' quotation links: a page and a PDF or two; a flood means someone is guessing.
const linkLimiter = perMinute(60, {
  handler: (req, res) => res.status(429).type('text').send('Too many requests. Please wait a minute and try again.'),
});

// The login page asks every 2 seconds whether its QR code was allowed (D58).
const qrPollLimiter = perMinute(120);

// The public API (Phase 10C): per API key, after the key is checked.
const publicApiLimiter = perMinute(env.rateLimit.publicApiPerMinute, { keyGenerator: (req) => `key:${req.apiKey.prefix}` });

module.exports = { apiLimiter, authLimiter, webhookLimiter, formLimiter, linkLimiter, publicApiLimiter, qrPollLimiter };
