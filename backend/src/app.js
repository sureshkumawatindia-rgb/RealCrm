const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const requestId = require('./middleware/requestId');
const rejectUnsafeKeys = require('./middleware/sanitize');
const { apiLimiter } = require('./middleware/rateLimit');
const errorHandler = require('./middleware/errorHandler');
const phoneMasking = require('./middleware/phoneMasking');
const routes = require('./routes');
const webhookRoutes = require('./routes/webhooks');
const publicRoutes = require('./routes/public');
const quotationLinkRoutes = require('./routes/quotationLinks');
const publicApiRoutes = require('./routes/publicApi');
const logger = require('./config/logger');
const path = require('path');
const env = require('./config/env');
const { logoStorage } = require('./storage');
const { NAME_PATTERN } = require('./storage/localDisk');

const app = express();
const frontendDir = path.resolve(__dirname, '..', '..', 'crm', 'frontend');
// Behind a proxy (nginx, a hosting platform): the client's address and https come from it.
if (env.trustProxy) app.set('trust proxy', env.trustProxy);

app.use(requestId);
// Staging (F2) is never shown by search engines.
if (env.isStaging) {
  app.use((req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
}

// The CRM pages, so this one server runs the whole CRM (see start-crm.vbs).
// Served before helmet: its script rules would block the pages' inline scripts and Google
// sign-in. The pages get their own security headers instead (BUG-002, Phase 3 D115): no other
// site may show them in a frame (clickjacking), no file is guessed into a script, links take
// only this address along, and in production the browser always comes back over https.
function pageHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (env.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}
app.get('/', (req, res) => res.redirect('/crm/frontend/index.html'));
// Browsers ask for /favicon.ico on every page that names no icon: the app's own icon.
app.get('/favicon.ico', pageHeaders, (req, res) => res.sendFile(path.join(frontendDir, 'img', 'icons', 'icon-192.png'), { maxAge: '7d' }));
app.use('/crm/frontend', pageHeaders, express.static(frontendDir));
// An address under the CRM with no page: a page that says so (not the API's JSON answer).
app.use('/crm/frontend', (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) return next();
  res.status(404).sendFile(path.join(frontendDir, '404.html'));
});

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
// Browsers may call the API only from the allowlisted origins; requests without an Origin
// (same-origin GETs, server-to-server calls, OAuth redirects) are not affected.
app.use(cors({
  origin: (origin, callback) => callback(null, !origin || env.corsOrigins.includes(origin)),
  credentials: true,
}));
// Webhooks are signed over the exact bytes that were sent, so they keep a raw body.
// The platform's Meta webhook carries chat history in chunks (D60): a larger limit there.
app.use('/api/v1/webhooks/meta', express.raw({ type: () => true, limit: '16mb' }));
app.use('/api/v1/webhooks', express.raw({ type: () => true, limit: '3mb' }));
// A browser-data import carries the whole old localStorage in one request.
app.use('/api/v1/imports/localstorage', express.json({ limit: '25mb' }));
app.use(express.json({ limit: '5mb' }));
app.use(rejectUnsafeKeys);

// Uploaded files (logos) are never allowed to run scripts, even when opened directly. They come
// from the storage (F5: the disk folder or R2), at the same addresses as before.
const LOGO_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
app.get('/uploads/:name', async (req, res, next) => {
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  const type = LOGO_TYPES[path.extname(req.params.name).slice(1).toLowerCase()];
  if (!type || !NAME_PATTERN.test(req.params.name)) return res.status(404).end();
  try {
    const stream = await logoStorage.open(req.params.name);
    if (!stream) return res.status(404).end();
    res.setHeader('Content-Type', type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    stream.on('error', next);
    return stream.pipe(res);
  } catch (error) {
    return next(error);
  }
});

// Paths only: query strings can carry OAuth codes and invite tokens; webhook keys are masked.
morgan.token('path', (req) => req.originalUrl.split('?')[0].replace(/^(\/api\/v1\/webhooks\/(?:leads\/|payments\/)?[a-z-]+\/)[^/]+/, '$1…'));
app.use(morgan(':remote-addr :method :path :status :res[content-length] - :response-time ms', {
  stream: { write: message => logger.info(message.trim()) }
}));

// Public webhooks (WhatsApp, lead sources, payment gateways) have their own rate limit.
app.use('/api/v1/webhooks', webhookRoutes);
// Website enquiry forms: called from the organization's own sites, with their own rate limit.
app.use('/api/v1/public', publicRoutes);
// Customers' quotation links (/q/<signed id>), with their own rate limit and strict headers.
app.use('/q', quotationLinkRoutes);
// The public REST API for the companies' own systems, Zapier and Make (API keys, Phase 10C).
app.use('/api/public/v1', publicApiRoutes);
// Agents and viewers never get customers' full numbers (D65).
app.use('/api/v1', apiLimiter, phoneMasking, routes);

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: 'Resource not found',
    code: 'NOT_FOUND',
    requestId: req.id
  });
});

app.use(errorHandler);

module.exports = app;
