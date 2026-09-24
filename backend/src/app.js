const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const requestId = require('./middleware/requestId');
const rejectUnsafeKeys = require('./middleware/sanitize');
const { apiLimiter } = require('./middleware/rateLimit');
const errorHandler = require('./middleware/errorHandler');
const routes = require('./routes');
const logger = require('./config/logger');
const path = require('path');
const env = require('./config/env');

const app = express();
const frontendDir = path.resolve(__dirname, '..', '..', 'crm', 'frontend');

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
app.use(express.json({ limit: '5mb' }));
app.use(rejectUnsafeKeys);

// Uploaded files (logos) are never allowed to run scripts, even when opened directly.
app.use('/uploads', (req, res, next) => {
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  next();
}, express.static(path.resolve(env.uploadDir)));

// Paths only: query strings can carry OAuth codes and invite tokens.
morgan.token('path', (req) => req.originalUrl.split('?')[0]);
app.use(morgan(':remote-addr :method :path :status :res[content-length] - :response-time ms', {
  stream: { write: message => logger.info(message.trim()) }
}));

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
