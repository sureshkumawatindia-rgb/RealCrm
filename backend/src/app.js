const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const requestId = require('./middleware/requestId');
const rejectUnsafeKeys = require('./middleware/sanitize');
const { apiLimiter } = require('./middleware/rateLimit');
const errorHandler = require('./middleware/errorHandler');
const routes = require('./routes');
const webhookRoutes = require('./routes/webhooks');
const publicRoutes = require('./routes/public');
const quotationLinkRoutes = require('./routes/quotationLinks');
const publicApiRoutes = require('./routes/publicApi');
const logger = require('./config/logger');
const path = require('path');
const env = require('./config/env');

const app = express();
const frontendDir = path.resolve(__dirname, '..', '..', 'crm', 'frontend');
// Behind a proxy (nginx, a hosting platform): the client's address and https come from it.
if (env.trustProxy) app.set('trust proxy', env.trustProxy);

app.use(requestId);

// The CRM pages, so this one server runs the whole CRM (see start-crm.vbs).
// Served before helmet: its headers would block the pages' inline scripts and Google sign-in.
app.get('/', (req, res) => res.redirect('/crm/frontend/index.html'));
app.use('/crm/frontend', express.static(frontendDir));

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

// Uploaded files (logos) are never allowed to run scripts, even when opened directly.
app.use('/uploads', (req, res, next) => {
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  next();
}, express.static(path.resolve(env.uploadDir)));

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
app.use('/api/v1', apiLimiter, routes);

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
